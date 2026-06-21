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

describe("qualifying round-trip (doQualifyingTrade)", () => {
  it("buys ETH then immediately sells it back, returning true on success", async () => {
    const swaps: MockSwap[] = [];
    const exec = {
      mark: () => {},
      getPortfolio: fundedPortfolio,
      swap: async (r: MockSwap) => {
        swaps.push(r);
        return { ok: true, txHash: "0xabc" };
      },
    };
    const { svc } = makeService(exec, ethPrice);
    expect(await svc.doQualifyingTrade()).toBe(true);
    expect(swaps.length).toBe(2);
    expect([swaps[0].fromSymbol, swaps[0].toSymbol]).toEqual(["USDT", "ETH"]); // buy
    expect([swaps[1].fromSymbol, swaps[1].toSymbol]).toEqual(["ETH", "USDT"]); // sell back
  });

  it("falls back to selling held ETH when the main loop has tied up USDT cash", async () => {
    const swaps: MockSwap[] = [];
    const exec = {
      mark: () => {},
      // Cash is below the $1.5 size (deployed into an open ETH position), but ETH is held.
      getPortfolio: async () => ({
        totalValueUsd: 10,
        cashUsd: 0.5,
        holdings: [{ symbol: "ETH", amount: 0.003, valueUsd: 9 }],
      }),
      swap: async (r: MockSwap) => {
        swaps.push(r);
        return { ok: true, txHash: "0xeth" };
      },
    };
    const { svc } = makeService(exec, ethPrice);
    expect(await svc.doQualifyingTrade()).toBe(true);
    expect(swaps.length).toBe(2);
    expect([swaps[0].fromSymbol, swaps[0].toSymbol]).toEqual(["ETH", "USDT"]); // sell first
    expect([swaps[1].fromSymbol, swaps[1].toSymbol]).toEqual(["USDT", "ETH"]); // rebuy back
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
});
