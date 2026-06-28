import { describe, expect, it, beforeAll, spyOn } from "bun:test";
import { logger, type IAgentRuntime } from "@elizaos/core";
import { TradingService, type PositionsReport } from "../agent/service";

/**
 * Unit tests for the Track-1 qualifying round-trip (doQualifyingTrade) — the core of
 * the standalone 12h heartbeat. We construct a TradingService and override its private
 * executor/provider with mocks (no network, no real swaps, no API credits), then drive
 * the round-trip directly to lock in: buy→sell on success, and the failure paths that
 * make runQualifyCycle retry in 5 min.
 */

beforeAll(() => {
  spyOn(logger, "info");
  spyOn(logger, "warn");
  spyOn(logger, "error");
});

interface MockSwap {
  fromSymbol: string;
  toSymbol: string;
  amountUsd: number;
  maxSlippageBps: number;
}

// Build a TradingService with mocked executor + provider (private fields overridden).
function makeService(
  exec: unknown,
  prov: unknown,
): {
  svc: { doQualifyingTrade(): Promise<boolean> };
  raw: Record<string, unknown>;
} {
  const runtime = {
    getService: () => null,
    character: { name: "Test" },
    agentId: "test",
  } as unknown as IAgentRuntime;
  const raw = new TradingService(runtime) as unknown as Record<string, unknown>;
  raw.executor = exec;
  raw.provider = prov;
  return {
    svc: raw as unknown as { doQualifyingTrade(): Promise<boolean> },
    raw,
  };
}

/** A fake open ETH position entered at $3000. */
const openTrade = (id = "t1") => ({
  id,
  asset: "ETH",
  timeframe: "daily",
  sizeUsd: 5,
  entryPrice: 3000,
  boughtAmount: 5 / 3000,
  openedAt: Date.now(),
  closeAt: Date.now() + 86_400_000,
});

const ethPrice = {
  getTokenSignals: async () => [{ symbol: "ETH", priceUsd: 3000 }],
};
const fundedPortfolio = async () => ({
  totalValueUsd: 100,
  cashUsd: 100,
  holdings: [],
});

/**
 * Stateful executor mock: tracks USDT cash + ETH amount and updates them on each swap,
 * with a small fill fee so the amount received is slightly LESS than requested (like a real
 * DEX). The balance-aware Track-1 sell-back re-reads the wallet after the buy and sells only
 * the ETH it actually received, so a static portfolio can't exercise it. TWAK reports
 * valueUsd:0 for ETH, so the mock does too — the code prices ETH itself (amount × price).
 */
function statefulExec(
  init: { cashUsd: number; ethAmount: number },
  price = 3000,
  fee = 0.99,
): { exec: unknown; swaps: MockSwap[] } {
  const state = { ...init };
  const swaps: MockSwap[] = [];
  const exec = {
    mark: () => {},
    getPortfolio: async () => ({
      totalValueUsd: state.cashUsd + state.ethAmount * price,
      cashUsd: state.cashUsd,
      holdings:
        state.ethAmount > 1e-12
          ? [{ symbol: "ETH", amount: state.ethAmount, valueUsd: 0 }]
          : [],
    }),
    swap: async (r: MockSwap) => {
      swaps.push(r);
      if (r.fromSymbol === "USDT" && r.toSymbol === "ETH") {
        state.cashUsd -= r.amountUsd;
        state.ethAmount += (r.amountUsd / price) * fee;
      } else if (r.fromSymbol === "ETH" && r.toSymbol === "USDT") {
        state.ethAmount = Math.max(0, state.ethAmount - r.amountUsd / price);
        state.cashUsd += r.amountUsd * fee;
      }
      return { ok: true, txHash: "0x" };
    },
  };
  return { exec, swaps };
}

describe("qualifying round-trip (doQualifyingTrade)", () => {
  it("buys ETH then sells back only what it received — never over-requests (haircut)", async () => {
    const { exec, swaps } = statefulExec({ cashUsd: 100, ethAmount: 0 });
    const { svc } = makeService(exec, ethPrice);
    expect(await svc.doQualifyingTrade()).toBe(true);
    const buy = swaps.find((s) => s.fromSymbol === "USDT" && s.toSymbol === "ETH");
    const sell = swaps.find((s) => s.fromSymbol === "ETH" && s.toSymbol === "USDT");
    expect(buy).toBeDefined(); // the qualifying BUY (this leg counts)
    expect(sell).toBeDefined(); // the sell-back that flattens it
    // The sell-back is sized off the ETH actually received (buy size × fill) minus the
    // haircut, so it requests strictly LESS than the buy — never the full nominal (which
    // is what stranded the ETH before, since a live swap rejects an over-balance amount).
    expect(sell!.amountUsd).toBeLessThan(buy!.amountUsd);
  });

  it("when USDT cash is tied up in a TRACKED position, sells ETH first then rebuys", async () => {
    // A main-loop position holds 0.003 ETH and the wallet holds exactly that (no stray to
    // flatten); USDT cash is below the $1.5 size. The heartbeat must still land by selling
    // ETH then rebuying it — restoring the starting allocation.
    const { exec, swaps } = statefulExec({ cashUsd: 0.5, ethAmount: 0.003 });
    const { svc, raw } = makeService(exec, ethPrice);
    (raw.forecastTrades as Map<string, unknown>).set("loop1", {
      ...openTrade("loop1"),
      boughtAmount: 0.003, // tracked → not treated as stray
    });
    expect(await svc.doQualifyingTrade()).toBe(true);
    const sellIdx = swaps.findIndex(
      (s) => s.fromSymbol === "ETH" && s.toSymbol === "USDT",
    );
    const buyIdx = swaps.findIndex(
      (s) => s.fromSymbol === "USDT" && s.toSymbol === "ETH",
    );
    expect(sellIdx).toBeGreaterThanOrEqual(0);
    expect(buyIdx).toBeGreaterThan(sellIdx); // sold first, then rebought
  });

  it("does NOT report success when the sell-back fails — returns false so it retries", async () => {
    // Buy succeeds but every ETH→USDT sell reverts (e.g. live insufficient-balance): the
    // bought ETH is left in the wallet. The heartbeat must NOT claim a clean round-trip
    // (that reschedules a full interval out and strands the ETH) — it returns false so
    // runQualifyCycle retries on the short cadence and flattens the stray on the next pass.
    let eth = 0;
    const swaps: MockSwap[] = [];
    const exec = {
      mark: () => {},
      getPortfolio: async () => ({
        totalValueUsd: 100,
        cashUsd: 100,
        holdings: eth > 1e-12 ? [{ symbol: "ETH", amount: eth, valueUsd: 0 }] : [],
      }),
      swap: async (r: MockSwap) => {
        swaps.push(r);
        if (r.fromSymbol === "USDT" && r.toSymbol === "ETH") {
          eth += (r.amountUsd / 3000) * 0.99;
          return { ok: true, txHash: "0xbuy" };
        }
        return { ok: false, error: "insufficient balance" }; // sell-back always fails
      },
    };
    const { svc } = makeService(exec, ethPrice);
    expect(await svc.doQualifyingTrade()).toBe(false);
    expect(
      swaps.some((s) => s.fromSymbol === "USDT" && s.toSymbol === "ETH"),
    ).toBe(true); // the buy did happen
  });

  it("returns false (→ heartbeat will retry in 5 min) when the buy fails (e.g. 403)", async () => {
    const exec = {
      mark: () => {},
      getPortfolio: fundedPortfolio,
      swap: async () => ({ ok: false, error: "403 Forbidden" }),
    };
    const { svc } = makeService(exec, ethPrice);
    expect(await svc.doQualifyingTrade()).toBe(false);
  });

  it("returns false when cash is below the trade size AND no ETH to fall back on", async () => {
    const exec = {
      mark: () => {},
      getPortfolio: async () => ({
        totalValueUsd: 1,
        cashUsd: 1,
        holdings: [],
      }),
      swap: async () => ({ ok: true, txHash: "0x" }),
    };
    const { svc } = makeService(exec, ethPrice);
    expect(await svc.doQualifyingTrade()).toBe(false);
  });

  it("returns false when no ETH price is available", async () => {
    const exec = {
      mark: () => {},
      getPortfolio: fundedPortfolio,
      swap: async () => ({ ok: true }),
    };
    const noPrice = {
      getTokenSignals: async () => [{ symbol: "ETH", priceUsd: 0 }],
    };
    const { svc } = makeService(exec, noPrice);
    expect(await svc.doQualifyingTrade()).toBe(false);
  });
});

describe("take-profit monitor (checkTakeProfit)", () => {
  const callCheck = (raw: Record<string, unknown>) =>
    (
      raw as unknown as { checkTakeProfit(): Promise<number> }
    ).checkTakeProfit();
  const positions = (raw: Record<string, unknown>) =>
    raw.forecastTrades as Map<string, unknown>;

  it("closes a position early once it's up the take-profit %", async () => {
    const swaps: MockSwap[] = [];
    const exec = {
      mark: () => {},
      getPortfolio: fundedPortfolio,
      swap: async (r: MockSwap) => {
        swaps.push(r);
        return { ok: true, txHash: "0xtp" };
      },
    };
    // ETH now $3300 = +10% over the $3000 entry → take-profit fires.
    const prov = {
      getTokenSignals: async () => [{ symbol: "ETH", priceUsd: 3300 }],
    };
    const { raw } = makeService(exec, prov);
    raw.takeProfitEnabled = true;
    raw.takeProfitPct = 10;
    positions(raw).set("t1", openTrade());

    expect(await callCheck(raw)).toBe(1);
    expect(positions(raw).size).toBe(0); // position closed
    expect(
      swaps.some((s) => s.fromSymbol === "ETH" && s.toSymbol === "USDT"),
    ).toBe(true);
  });

  it("holds the position when the gain is below the target", async () => {
    const exec = {
      mark: () => {},
      getPortfolio: fundedPortfolio,
      swap: async () => ({ ok: true, txHash: "0x" }),
    };
    const prov = {
      getTokenSignals: async () => [{ symbol: "ETH", priceUsd: 3150 }], // +5%
    };
    const { raw } = makeService(exec, prov);
    raw.takeProfitEnabled = true;
    raw.takeProfitPct = 10;
    positions(raw).set("t1", openTrade());

    expect(await callCheck(raw)).toBe(0);
    expect(positions(raw).size).toBe(1); // still open
  });

  it("does nothing when take-profit is disabled (toggle off)", async () => {
    const exec = {
      mark: () => {},
      getPortfolio: fundedPortfolio,
      swap: async () => ({ ok: true }),
    };
    const prov = {
      getTokenSignals: async () => [{ symbol: "ETH", priceUsd: 4000 }], // +33%
    };
    const { raw } = makeService(exec, prov);
    raw.takeProfitEnabled = false;
    raw.takeProfitPct = 10;
    positions(raw).set("t1", openTrade());

    expect(await callCheck(raw)).toBe(0);
    expect(positions(raw).size).toBe(1);
  });
});

describe("getPositions (open positions with live PnL — agent status)", () => {
  const callGet = (raw: Record<string, unknown>) =>
    (raw as unknown as { getPositions(): Promise<PositionsReport> }).getPositions();
  const setTrades = (raw: Record<string, unknown>) =>
    raw.forecastTrades as Map<string, unknown>;
  const exec = {
    mark: () => {},
    getPortfolio: fundedPortfolio,
    swap: async () => ({ ok: true }),
  };

  it("marks each position to market and computes PnL + totals", async () => {
    const prov = {
      getTokenSignals: async () => [{ symbol: "ETH", priceUsd: 3300 }], // +10% on the $3000 entry
    };
    const { raw } = makeService(exec, prov);
    setTrades(raw).set("t1", openTrade());

    const rep = await callGet(raw);
    expect(rep.positions.length).toBe(1);
    const p = rep.positions[0];
    expect(p.asset).toBe("ETH");
    expect(p.currentPrice).toBe(3300);
    expect(p.priced).toBe(true);
    expect(p.pnlPct).toBeCloseTo(10, 6);
    expect(p.pnlUsd).toBeCloseTo((5 / 3000) * 300, 6); // boughtAmount * (3300-3000) = 0.5
    expect(rep.totalPnlUsd).toBeCloseTo(0.5, 6);
    expect(rep.anyPriced).toBe(true);
  });

  it("falls back to entry price (flat PnL) when no live price is available", async () => {
    const prov = { getTokenSignals: async () => [] };
    const { raw } = makeService(exec, prov);
    setTrades(raw).set("t1", openTrade());

    const rep = await callGet(raw);
    expect(rep.anyPriced).toBe(false);
    expect(rep.positions[0].currentPrice).toBe(3000);
    expect(rep.positions[0].pnlUsd).toBe(0);
    expect(rep.positions[0].priced).toBe(false);
  });

  it("returns an empty report when the agent holds nothing", async () => {
    const { raw } = makeService(exec, ethPrice);
    const rep = await callGet(raw);
    expect(rep.positions.length).toBe(0);
    expect(rep.totalPnlUsd).toBe(0);
    expect(rep.anyPriced).toBe(false);
  });
});

describe("closeForecastTrade — no double-sell on a concurrent close race", () => {
  it("sells a position EXACTLY once when several closers race the same id", async () => {
    const swaps: MockSwap[] = [];
    const exec = {
      mark: () => {},
      getPortfolio: fundedPortfolio,
      swap: async (r: MockSwap) => {
        swaps.push(r);
        return { ok: true, txHash: "0xclose" };
      },
    };
    const prov = {
      getTokenSignals: async () => [{ symbol: "ETH", priceUsd: 3100 }],
    };
    const { raw } = makeService(exec, prov);
    (raw.forecastTrades as Map<string, unknown>).set("t1", openTrade());

    // The auto-close timer + take-profit monitor + close-all could all fire at once.
    const close = (
      raw as unknown as { closeForecastTrade(id: string): Promise<void> }
    ).closeForecastTrade.bind(raw);
    await Promise.all([close("t1"), close("t1"), close("t1")]);

    expect(swaps.length).toBe(1); // sold once, NOT three times
    expect([swaps[0].fromSymbol, swaps[0].toSymbol]).toEqual(["ETH", "USDT"]);
    expect((raw.forecastTrades as Map<string, unknown>).size).toBe(0);
  });

  it("never sells MORE than the wallet actually holds (buy-fee dust) on close", async () => {
    const swaps: MockSwap[] = [];
    // openTrade() records boughtAmount = 5/3000 (the IDEAL fill). The wallet only got
    // 0.00150 ETH (a buy fee ate the rest) — selling boughtAmount worth would exceed it.
    const heldEth = 0.0015;
    const exec = {
      mark: () => {},
      getPortfolio: async () => ({
        totalValueUsd: 5,
        cashUsd: 0,
        holdings: [{ symbol: "ETH", amount: heldEth, valueUsd: heldEth * 3100 }],
      }),
      swap: async (r: MockSwap) => {
        swaps.push(r);
        return { ok: true, txHash: "0xclose" };
      },
    };
    const prov = {
      getTokenSignals: async () => [{ symbol: "ETH", priceUsd: 3100 }],
    };
    const { raw } = makeService(exec, prov);
    (raw.forecastTrades as Map<string, unknown>).set("t1", openTrade());

    await (
      raw as unknown as { closeForecastTrade(id: string): Promise<void> }
    ).closeForecastTrade("t1");

    expect(swaps.length).toBe(1);
    // The requested USD must be ≤ the value actually held (capped at heldEth, minus haircut).
    expect(swaps[0].amountUsd).toBeLessThanOrEqual(heldEth * 3100);
    expect(swaps[0].amountUsd).toBeGreaterThan(0);
  });
});
