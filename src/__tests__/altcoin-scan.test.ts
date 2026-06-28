import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  altcoinMinConfidencePct,
  altcoinQualifies,
  altcoinResearchTimeframe,
  altcoinRetryMs,
  altcoinScanDepth,
  altcoinTradesEnabled,
  altcoinUseContract,
  pickBullishAltcoin,
  shouldDivertToAltcoins,
  type AltcoinCandidate,
} from "../skills/altcoin-scan/scan";
import { buildSwapArgs, tokenArg } from "../exec/twak";
import { BSC_CONTRACTS, bscContractFor } from "../config/bsc-contracts";
import { TradingService } from "../agent/service";
import { CmcDataProvider } from "../data/cmc";
import { createMockRuntime } from "./utils/core-test-utils";

function restoreEnv(key: string, saved: string | undefined) {
  if (saved === undefined) delete process.env[key];
  else process.env[key] = saved;
}

const cand = (
  symbol: string,
  bias: AltcoinCandidate["bias"],
  confidence: number,
  priceUsd = 1,
): AltcoinCandidate => ({ symbol, bias, confidence, priceUsd });

/**
 * Env-config readers for the Track-1 high-risk altcoin feature: the master toggle and the
 * scan-depth / min-confidence / retry / research-timeframe / use-contract knobs. Verifies
 * defaults, parsing and clamping so the .env values behave exactly as documented.
 */
describe("altcoin-scan env config", () => {
  const KEYS = [
    "TRACK1_ALTCOIN_TRADES_ENABLED",
    "TRACK1_ALTCOIN_SCAN_DEPTH",
    "TRACK1_ALTCOIN_MIN_CONFIDENCE",
    "TRACK1_ALTCOIN_RETRY_MS",
    "TRACK1_ALTCOIN_RESEARCH_TIMEFRAME",
    "TRACK1_ALTCOIN_USE_CONTRACT",
  ];
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  afterEach(() => {
    for (const k of KEYS) restoreEnv(k, saved[k]);
  });

  it("master toggle is OFF unless the literal 'true'", () => {
    delete process.env.TRACK1_ALTCOIN_TRADES_ENABLED;
    expect(altcoinTradesEnabled()).toBe(false);
    process.env.TRACK1_ALTCOIN_TRADES_ENABLED = "1";
    expect(altcoinTradesEnabled()).toBe(false);
    process.env.TRACK1_ALTCOIN_TRADES_ENABLED = "  TRUE ";
    expect(altcoinTradesEnabled()).toBe(true);
  });

  it("scan depth defaults to 5 and clamps to 1–50", () => {
    delete process.env.TRACK1_ALTCOIN_SCAN_DEPTH;
    expect(altcoinScanDepth()).toBe(5);
    process.env.TRACK1_ALTCOIN_SCAN_DEPTH = "3";
    expect(altcoinScanDepth()).toBe(3);
    process.env.TRACK1_ALTCOIN_SCAN_DEPTH = "0";
    expect(altcoinScanDepth()).toBe(1);
    process.env.TRACK1_ALTCOIN_SCAN_DEPTH = "999";
    expect(altcoinScanDepth()).toBe(50);
    process.env.TRACK1_ALTCOIN_SCAN_DEPTH = "nope";
    expect(altcoinScanDepth()).toBe(5);
  });

  it("min confidence defaults to 60 and clamps to 0–100", () => {
    delete process.env.TRACK1_ALTCOIN_MIN_CONFIDENCE;
    expect(altcoinMinConfidencePct()).toBe(60);
    process.env.TRACK1_ALTCOIN_MIN_CONFIDENCE = "75";
    expect(altcoinMinConfidencePct()).toBe(75);
    process.env.TRACK1_ALTCOIN_MIN_CONFIDENCE = "250";
    expect(altcoinMinConfidencePct()).toBe(100);
  });

  it("retry delay defaults to 1h and is floored at 60s", () => {
    delete process.env.TRACK1_ALTCOIN_RETRY_MS;
    expect(altcoinRetryMs()).toBe(3_600_000);
    process.env.TRACK1_ALTCOIN_RETRY_MS = "1000"; // below the 60s floor
    expect(altcoinRetryMs()).toBe(60_000);
    process.env.TRACK1_ALTCOIN_RETRY_MS = "120000";
    expect(altcoinRetryMs()).toBe(120_000);
  });

  it("research timeframe defaults to 1h and maps aliases", () => {
    delete process.env.TRACK1_ALTCOIN_RESEARCH_TIMEFRAME;
    expect(altcoinResearchTimeframe()).toBe("1h");
    process.env.TRACK1_ALTCOIN_RESEARCH_TIMEFRAME = "daily";
    expect(altcoinResearchTimeframe()).toBe("1D");
    process.env.TRACK1_ALTCOIN_RESEARCH_TIMEFRAME = "weekly";
    expect(altcoinResearchTimeframe()).toBe("1W");
    process.env.TRACK1_ALTCOIN_RESEARCH_TIMEFRAME = "garbage";
    expect(altcoinResearchTimeframe()).toBe("1h");
  });

  it("use-contract defaults ON and only 'false' disables it", () => {
    delete process.env.TRACK1_ALTCOIN_USE_CONTRACT;
    expect(altcoinUseContract()).toBe(true);
    process.env.TRACK1_ALTCOIN_USE_CONTRACT = "false";
    expect(altcoinUseContract()).toBe(false);
    process.env.TRACK1_ALTCOIN_USE_CONTRACT = "true";
    expect(altcoinUseContract()).toBe(true);
  });
});

/** The divert rule: bullish (up) and sideways divert to the altcoin hunt; down does not. */
describe("shouldDivertToAltcoins", () => {
  it("diverts on up and sideways, not on down/undefined", () => {
    expect(shouldDivertToAltcoins("up")).toBe(true);
    expect(shouldDivertToAltcoins("sideways")).toBe(true);
    expect(shouldDivertToAltcoins("down")).toBe(false);
    expect(shouldDivertToAltcoins(undefined)).toBe(false);
  });
});

/** Candidate selection — first bullish ≥ threshold within the scan depth wins. */
describe("pickBullishAltcoin / altcoinQualifies", () => {
  it("only bullish AND confident AND priced candidates qualify", () => {
    expect(altcoinQualifies(cand("A", "bullish", 0.7), 60)).toBe(true);
    expect(altcoinQualifies(cand("A", "bullish", 0.5), 60)).toBe(false); // not confident enough
    expect(altcoinQualifies(cand("A", "bearish", 0.9), 60)).toBe(false); // wrong bias
    expect(altcoinQualifies(cand("A", "neutral", 0.9), 60)).toBe(false);
    expect(altcoinQualifies(cand("A", "bullish", 0.9, 0), 60)).toBe(false); // no price
    expect(altcoinQualifies(cand("A", "bullish", 0.6), 60)).toBe(true); // exactly at threshold
  });

  it("returns the FIRST qualifying candidate in trending order", () => {
    const list = [
      cand("WIF", "neutral", 0.9),
      cand("CAKE", "bearish", 0.8),
      cand("MYX", "bullish", 0.7),
      cand("AAVE", "bullish", 0.95),
    ];
    expect(
      pickBullishAltcoin(list, { minConfidencePct: 60, depth: 5 })?.symbol,
    ).toBe("MYX");
  });

  it("respects the scan depth window (won't look past it)", () => {
    const list = [
      cand("A", "neutral", 0.9),
      cand("B", "neutral", 0.9),
      cand("C", "bullish", 0.9), // only reachable at depth >= 3
    ];
    expect(
      pickBullishAltcoin(list, { minConfidencePct: 60, depth: 2 }),
    ).toBeUndefined();
    expect(
      pickBullishAltcoin(list, { minConfidencePct: 60, depth: 3 })?.symbol,
    ).toBe("C");
  });

  it("returns undefined when nothing qualifies", () => {
    const list = [cand("A", "neutral", 0.9), cand("B", "bearish", 0.9)];
    expect(
      pickBullishAltcoin(list, { minConfidencePct: 60, depth: 5 }),
    ).toBeUndefined();
  });
});

/**
 * The TWAK arg builder — the fix for the symbol/contract bug. It must hand TWAK the contract
 * ADDRESS for the leg that has one (so chain-ambiguous tickers can't mis-route), and the
 * ticker otherwise (the unambiguous USDT cash leg, or when use-contract is off).
 */
describe("tokenArg / buildSwapArgs (TWAK symbol→contract routing)", () => {
  it("tokenArg prefers a real address only when use-contract is on", () => {
    expect(tokenArg("MYX", "0xabc", true)).toBe("0xabc");
    expect(tokenArg("MYX", "0xabc", false)).toBe("MYX");
    expect(tokenArg("MYX", undefined, true)).toBe("MYX");
    expect(tokenArg("MYX", "   ", true)).toBe("MYX"); // blank address ignored
  });

  it("buys route the BUY leg by address, keep the USDT cash leg a symbol", () => {
    const args = buildSwapArgs(
      {
        fromSymbol: "USDT",
        toSymbol: "MYX",
        toAddress: "0xMYX",
        amountUsd: 5,
        maxSlippageBps: 100,
      },
      { chain: "bsc", slippagePct: 1, useContract: true },
    );
    expect(args).toEqual([
      "swap",
      "USDT",
      "0xMYX",
      "--usd",
      "5",
      "--chain",
      "bsc",
      "--slippage",
      "1",
      "--json",
    ]);
  });

  it("sell-backs route the SELL leg by address", () => {
    const args = buildSwapArgs(
      {
        fromSymbol: "MYX",
        fromAddress: "0xMYX",
        toSymbol: "USDT",
        amountUsd: 5,
        maxSlippageBps: 100,
      },
      { chain: "bsc", slippagePct: 1, useContract: true },
    );
    expect(args.slice(0, 3)).toEqual(["swap", "0xMYX", "USDT"]);
  });

  it("use-contract OFF falls back to tickers (legacy behavior)", () => {
    const args = buildSwapArgs(
      {
        fromSymbol: "USDT",
        toSymbol: "MYX",
        toAddress: "0xMYX",
        amountUsd: 5,
        maxSlippageBps: 100,
      },
      { chain: "bsc", slippagePct: 1, useContract: false },
    );
    expect(args.slice(0, 3)).toEqual(["swap", "USDT", "MYX"]);
  });
});

/**
 * The baked, one-time-resolved BSC contract map — the agent reads THIS instead of calling
 * CoinMarketCap per trade. Guards that every entry is a real 0x address, that the cash/base
 * legs and the no-BSC L1s are intentionally absent, and that lookup is case-insensitive.
 */
describe("baked BSC contract map", () => {
  it("holds the full eligible universe and only well-formed addresses", () => {
    const entries = Object.entries(BSC_CONTRACTS);
    expect(entries.length).toBe(144);
    for (const [, addr] of entries) {
      expect(addr).toMatch(/^0x[0-9a-fA-F]{40}$/);
    }
  });

  it("looks up case-insensitively", () => {
    expect(bscContractFor("cake")).toBe(BSC_CONTRACTS.CAKE);
    expect(bscContractFor("  MyX  ")).toBe(BSC_CONTRACTS.MYX);
  });

  it("maps TON/GRAM (Toncoin renamed to Gram) to the same BEP-20 contract", () => {
    const ton = "0x76a797a59ba2c17726896976b7b3747bfd1d220f";
    expect(bscContractFor("TON")).toBe(ton);
    expect(bscContractFor("GRAM")).toBe(ton); // CMC's current symbol for the same token
  });

  it("excludes ETH/USDT (route by symbol) and no-BSC L1s (H/IP)", () => {
    for (const sym of ["ETH", "USDT", "H", "IP"]) {
      expect(bscContractFor(sym)).toBeUndefined();
    }
    // USDF (Falcon USD) DID resolve to a real BSC contract, so it is mapped.
    expect(bscContractFor("USDF")).toBe(
      "0xb3b02e4a9fb2bd28cc2ff97b0ab3f6b3ec1ee9d2",
    );
  });
});

/**
 * Component test for the scan-and-trade integration on a real TradingService (paper mode,
 * CMC mocked). Proves the end-to-end rule: trending → filter to the eligible BSC watchlist →
 * research in order, STOP at the first bullish ≥ 60% → buy it (with the baked contract
 * address) → open an auto-closing position. And the "nothing qualifies → diverted no-trade".
 */
describe("scanAndTradeAltcoin (component)", () => {
  const SAVE_KEYS = [
    "ENABLE_LIVE_TRADING",
    "COINMARKETCAP_API_KEY",
    "ASTRAEUS_STATE_DIR",
    "RISK_MAX_TRADE_USD",
    "RISK_MAX_DAILY_VOLUME_USD",
    "RISK_MAX_TRADES_PER_DAY",
    "RISK_MIN_CONVICTION",
    "PAPER_START_CASH_USD",
    "TRACK1_TRENDING_WATCHLIST",
    "TRACK1_ALTCOIN_SCAN_DEPTH",
    "TRACK1_ALTCOIN_MIN_CONFIDENCE",
    "RISK_TAKE_PROFIT_ENABLED",
    "RISK_TAKE_PROFIT_PCT",
    "CLOSE_SELL_HAIRCUT_BPS",
    "CLOSE_PRICE_RETRIES",
    "CLOSE_PRICE_RETRY_MS",
  ];
  const saved = Object.fromEntries(SAVE_KEYS.map((k) => [k, process.env[k]]));
  const spies: Array<{ mockRestore: () => void }> = [];

  function newService() {
    process.env.ENABLE_LIVE_TRADING = "false"; // force paper executor
    process.env.COINMARKETCAP_API_KEY ||= "test-key";
    process.env.ASTRAEUS_STATE_DIR = mkdtempSync(
      join(tmpdir(), "astraeus-altcoin-"),
    );
    process.env.RISK_MAX_TRADE_USD = "5";
    process.env.RISK_MAX_DAILY_VOLUME_USD = "100";
    process.env.RISK_MAX_TRADES_PER_DAY = "8";
    process.env.RISK_MIN_CONVICTION = "60";
    process.env.PAPER_START_CASH_USD = "50";
    delete process.env.TRACK1_TRENDING_WATCHLIST; // use the baked-in default watchlist
    return new TradingService(createMockRuntime());
  }

  const base = {
    ok: true,
    traded: false,
    timeframe: "hourly" as const,
    direction: "sideways" as const,
    confidence: 0.5,
    entryPrice: 3000,
  };

  afterEach(() => {
    for (const s of spies.splice(0)) s.mockRestore();
    for (const k of SAVE_KEYS) restoreEnv(k, saved[k]);
  });

  it("filters to the watchlist, stops at the first bullish ≥60%, and buys it", async () => {
    const svc = newService();
    // Feed includes off-watchlist tokens (WIF/KGEN) that must be dropped, then on-list ones.
    spies.push(
      spyOn(CmcDataProvider.prototype, "getTrending").mockResolvedValue([
        { symbol: "WIF", name: "dogwifhat" }, // off-list → dropped
        { symbol: "CAKE", name: "PancakeSwap" }, // on-list, neutral → skip
        { symbol: "MYX", name: "MYX Finance" }, // on-list, bullish 70% → BUY
        { symbol: "AAVE", name: "Aave" }, // never reached
      ] as never),
    );
    const research = spyOn(svc, "researchToken").mockImplementation(
      async (symbol: string) => {
        if (symbol === "CAKE")
          return { bias: "neutral", confidence: 0.5, priceUsd: 2 };
        if (symbol === "MYX")
          return { bias: "bullish", confidence: 0.7, priceUsd: 0.1 };
        return { bias: "bullish", confidence: 0.95, priceUsd: 200 }; // AAVE — should be unused
      },
    );
    spies.push(research);

    const r = await svc.scanAndTradeAltcoin("hourly", base);

    expect(r.traded).toBe(true);
    expect(r.diverted).toBe(true);
    expect(r.tradedAsset).toBe("MYX");
    expect(r.confidence).toBeCloseTo(0.7, 5);
    expect(r.txHash).toMatch(/^0xpaper/); // paper executor filled it
    // Researched WIF was filtered out; CAKE then MYX researched; AAVE never reached.
    const researched = research.mock.calls.map((c) => c[0]);
    expect(researched).toEqual(["CAKE", "MYX"]);

    // The open position carries the baked BSC contract address for the live sell-back route.
    const open = (
      svc as never as {
        forecastTrades: Map<string, { asset: string; address?: string }>;
      }
    ).forecastTrades;
    const pos = [...open.values()].find((t) => t.asset === "MYX");
    expect(pos?.address).toBe(BSC_CONTRACTS.MYX);

    // cleanup: clear the armed auto-close timer so the test process exits cleanly.
    const timers = (
      svc as never as { timers: Map<string, ReturnType<typeof setTimeout>> }
    ).timers;
    for (const h of timers.values()) clearTimeout(h);
  });

  it("routes the altcoin SELL-back by the stored BSC contract address on close", async () => {
    // The other half of the contract-routing round trip: the BUY stores the baked address,
    // and the auto-close must hand that SAME address to the sell swap so a live TWAK exit
    // routes the exact on-chain token back to USDT (a chain-ambiguous ticker like MYX must
    // not mis-route on the way out either). Proven end-to-end on a real TradingService.
    const svc = newService();
    spies.push(
      spyOn(CmcDataProvider.prototype, "getTrending").mockResolvedValue([
        { symbol: "MYX", name: "MYX Finance" }, // on-list, bullish 70% → BUY
      ] as never),
    );
    spies.push(
      spyOn(svc, "researchToken").mockResolvedValue({
        bias: "bullish",
        confidence: 0.7,
        priceUsd: 0.1,
      }),
    );

    const open = await svc.scanAndTradeAltcoin("hourly", base);
    expect(open.traded).toBe(true);
    expect(open.tradedAsset).toBe("MYX");

    const trades = (
      svc as never as {
        forecastTrades: Map<string, { id: string; asset: string }>;
      }
    ).forecastTrades;
    const pos = [...trades.values()].find((t) => t.asset === "MYX");
    expect(pos).toBeDefined();

    // The close re-reads the live price via getTokenSignals — stub it (no network/credits).
    spies.push(
      spyOn(CmcDataProvider.prototype, "getTokenSignals").mockResolvedValue([
        { symbol: "MYX", priceUsd: 0.12 },
      ] as never),
    );

    // Capture the sell SwapRequest. Spying AFTER the buy means only the close's swap is
    // recorded; spyOn calls through, so the paper executor still settles the sale.
    const executor = (
      svc as never as { executor: { swap: (req: unknown) => unknown } }
    ).executor;
    const sellSpy = spyOn(executor, "swap");
    spies.push(sellSpy);

    // Drive the auto-close directly (the timer would otherwise fire a whole timeframe later).
    await (
      svc as never as { closeForecastTrade: (id: string) => Promise<void> }
    ).closeForecastTrade(pos!.id);

    const sell = sellSpy.mock.calls.at(-1)?.[0] as {
      fromSymbol: string;
      toSymbol: string;
      fromAddress?: string;
    };
    expect(sell.fromSymbol).toBe("MYX");
    expect(sell.toSymbol).toBe("USDT");
    expect(sell.fromAddress).toBe(BSC_CONTRACTS.MYX);

    // The position is fully closed (removed from the ledger) — no dangling timer to clear.
    expect([...trades.values()].some((t) => t.asset === "MYX")).toBe(false);
  });

  it("take-profit prices an altcoin position by its OWN asset, not ETH", async () => {
    // Regression: checkTakeProfit used to value EVERY open position at the ETH price, so a
    // MYX position (entry $0.10) was compared against ETH (~$3000) → a fake +3,000,000% gain
    // that force-closed it on the very next 5-min check. It must price MYX at MYX's price.
    process.env.RISK_TAKE_PROFIT_ENABLED = "true";
    process.env.RISK_TAKE_PROFIT_PCT = "10";
    const svc = newService(); // reads the take-profit env in its constructor

    spies.push(
      spyOn(CmcDataProvider.prototype, "getTrending").mockResolvedValue([
        { symbol: "MYX", name: "MYX Finance" },
      ] as never),
    );
    spies.push(
      spyOn(svc, "researchToken").mockResolvedValue({
        bias: "bullish",
        confidence: 0.7,
        priceUsd: 0.1,
      }),
    );
    const open = await svc.scanAndTradeAltcoin("hourly", base);
    expect(open.traded).toBe(true);

    const trades = (
      svc as never as { forecastTrades: Map<string, { asset: string }> }
    ).forecastTrades;
    expect([...trades.values()].some((t) => t.asset === "MYX")).toBe(true);

    // MYX FLAT at its $0.10 entry → 0% gain → must NOT take profit (the old ETH-priced bug
    // would close it here). getTokenSignals returns the ALTCOIN price, never ETH's.
    const sig = spyOn(
      CmcDataProvider.prototype,
      "getTokenSignals",
    ).mockResolvedValue([{ symbol: "MYX", priceUsd: 0.1 }] as never);
    spies.push(sig);
    expect(await svc.checkTakeProfit()).toBe(0);
    expect([...trades.values()].some((t) => t.asset === "MYX")).toBe(true);

    // MYX rises to $0.12 (+20% ≥ the 10% target) → take-profit fires and closes it.
    sig.mockResolvedValue([{ symbol: "MYX", priceUsd: 0.12 }] as never);
    expect(await svc.checkTakeProfit()).toBe(1);
    expect([...trades.values()].some((t) => t.asset === "MYX")).toBe(false);

    const timers = (
      svc as never as { timers: Map<string, ReturnType<typeof setTimeout>> }
    ).timers;
    for (const h of timers.values()) clearTimeout(h);
  });

  it("an altcoin position survives a restart: reconciled with its address, then sold back by it", async () => {
    // Restart safety: an open altcoin position must round-trip through disk and come back on a
    // brand-new service (the "restart") with its baked BSC contract address intact, so the
    // recovered position's sell-back still routes by address — identical to the ETH main loop.
    const svc1 = newService(); // sets ASTRAEUS_STATE_DIR to a fresh temp dir
    spies.push(
      spyOn(CmcDataProvider.prototype, "getTrending").mockResolvedValue([
        { symbol: "MYX", name: "MYX Finance" },
      ] as never),
    );
    spies.push(
      spyOn(svc1, "researchToken").mockResolvedValue({
        bias: "bullish",
        confidence: 0.7,
        priceUsd: 0.1,
      }),
    );
    const open = await svc1.scanAndTradeAltcoin("hourly", base);
    expect(open.traded).toBe(true);
    // Simulate the process exiting: clear svc1's armed auto-close timer.
    for (const h of (
      svc1 as never as { timers: Map<string, ReturnType<typeof setTimeout>> }
    ).timers.values())
      clearTimeout(h);

    // "Restart": a fresh service on the SAME state dir recovers the open position from disk.
    const svc2 = new TradingService(createMockRuntime());
    (
      svc2 as never as { reconcileOpenTrades: () => void }
    ).reconcileOpenTrades();
    const trades2 = (
      svc2 as never as {
        forecastTrades: Map<
          string,
          { id: string; asset: string; address?: string }
        >;
      }
    ).forecastTrades;
    const restored = [...trades2.values()].find((t) => t.asset === "MYX");
    expect(restored).toBeDefined();
    expect(restored!.address).toBe(BSC_CONTRACTS.MYX); // address survived the restart

    spies.push(
      spyOn(CmcDataProvider.prototype, "getTokenSignals").mockResolvedValue([
        { symbol: "MYX", priceUsd: 0.12 },
      ] as never),
    );
    const exec2 = (
      svc2 as never as { executor: { swap: (r: unknown) => unknown } }
    ).executor;
    const sellSpy = spyOn(exec2, "swap");
    spies.push(sellSpy);
    await (
      svc2 as never as { closeForecastTrade: (id: string) => Promise<void> }
    ).closeForecastTrade(restored!.id);

    const sell = sellSpy.mock.calls.at(-1)?.[0] as {
      fromSymbol: string;
      fromAddress?: string;
    };
    expect(sell.fromSymbol).toBe("MYX");
    expect(sell.fromAddress).toBe(BSC_CONTRACTS.MYX);
    expect([...trades2.values()].some((t) => t.asset === "MYX")).toBe(false);
  });

  it("sizes the sell-back off the CURRENT price with the haircut (never the entry price)", async () => {
    process.env.CLOSE_SELL_HAIRCUT_BPS = "100"; // 1% — clearly observable
    const svc = newService();
    spies.push(
      spyOn(CmcDataProvider.prototype, "getTrending").mockResolvedValue([
        { symbol: "MYX", name: "MYX Finance" },
      ] as never),
    );
    spies.push(
      spyOn(svc, "researchToken").mockResolvedValue({
        bias: "bullish",
        confidence: 0.7,
        priceUsd: 0.1, // entry $0.10
      }),
    );
    const open = await svc.scanAndTradeAltcoin("hourly", base);
    expect(open.traded).toBe(true);
    const trades = (
      svc as never as {
        forecastTrades: Map<
          string,
          { id: string; asset: string; boughtAmount: number }
        >;
      }
    ).forecastTrades;
    const pos = [...trades.values()].find((t) => t.asset === "MYX")!;

    // Price has DOUBLED to $0.20 since entry — the close must size off $0.20, not $0.10.
    spies.push(
      spyOn(CmcDataProvider.prototype, "getTokenSignals").mockResolvedValue([
        { symbol: "MYX", priceUsd: 0.2 },
      ] as never),
    );
    const exec = (
      svc as never as {
        executor: {
          swap: (r: unknown) => unknown;
          getPortfolio: () => Promise<{
            holdings: { symbol: string; amount: number }[];
          }>;
        };
      }
    ).executor;
    const held = (await exec.getPortfolio()).holdings.find(
      (h) => h.symbol === "MYX",
    )!.amount;
    const sellSpy = spyOn(exec, "swap");
    spies.push(sellSpy);
    await (
      svc as never as { closeForecastTrade: (id: string) => Promise<void> }
    ).closeForecastTrade(pos.id);

    const sell = sellSpy.mock.calls.at(-1)?.[0] as { amountUsd: number };
    const sellAmount = Math.min(pos.boughtAmount, held);
    expect(sell.amountUsd).toBeCloseTo(
      sellAmount * 0.2 * (1 - 100 / 10_000),
      6,
    );
    // and emphatically NOT the entry-priced amount
    expect(sell.amountUsd).not.toBeCloseTo(
      sellAmount * 0.1 * (1 - 100 / 10_000),
      6,
    );
  });

  it("retries the price 5× then falls back to the on-chain valuation (not the entry price)", async () => {
    // Answers: "what if the agent can't get the price at withdraw?" → it RETRIES the live quote
    // (default 5×) and, only then, sizes off the wallet's CURRENT on-chain worth (value ÷
    // amount) — NOT the price it bought at.
    process.env.CLOSE_SELL_HAIRCUT_BPS = "0"; // isolate the price basis
    process.env.CLOSE_PRICE_RETRY_MS = "0"; // no real wait between retries in the test
    const svc = newService();
    spies.push(
      spyOn(CmcDataProvider.prototype, "getTrending").mockResolvedValue([
        { symbol: "MYX", name: "MYX Finance" },
      ] as never),
    );
    spies.push(
      spyOn(svc, "researchToken").mockResolvedValue({
        bias: "bullish",
        confidence: 0.7,
        priceUsd: 0.1, // entry $0.10
      }),
    );
    const open = await svc.scanAndTradeAltcoin("hourly", base);
    expect(open.traded).toBe(true);
    const trades = (
      svc as never as {
        forecastTrades: Map<
          string,
          { id: string; asset: string; boughtAmount: number }
        >;
      }
    ).forecastTrades;
    const pos = [...trades.values()].find((t) => t.asset === "MYX")!;

    // The wallet now values MYX at $0.20 on-chain, but the price quote is DOWN.
    const exec = (
      svc as never as {
        executor: {
          mark: (p: Record<string, number>) => void;
          swap: (r: unknown) => unknown;
          getPortfolio: () => Promise<{
            holdings: { symbol: string; amount: number }[];
          }>;
        };
      }
    ).executor;
    exec.mark({ MYX: 0.2 }); // on-chain value ⇒ heldValueUsd / amount = $0.20
    const held = (await exec.getPortfolio()).holdings.find(
      (h) => h.symbol === "MYX",
    )!.amount;
    const priceSpy = spyOn(
      CmcDataProvider.prototype,
      "getTokenSignals",
    ).mockRejectedValue(new Error("CMC unavailable"));
    spies.push(priceSpy);
    const sellSpy = spyOn(exec, "swap");
    spies.push(sellSpy);
    await (
      svc as never as { closeForecastTrade: (id: string) => Promise<void> }
    ).closeForecastTrade(pos.id);

    // It retried the live quote the full 5× (default) before giving up on it.
    expect(priceSpy).toHaveBeenCalledTimes(5);
    const sell = sellSpy.mock.calls.at(-1)?.[0] as { amountUsd: number };
    const sellAmount = Math.min(pos.boughtAmount, held);
    expect(sell.amountUsd).toBeCloseTo(sellAmount * 0.2, 6); // on-chain $0.20, not entry $0.10
    expect(sell.amountUsd).not.toBeCloseTo(sellAmount * 0.1, 6);
  });

  it("opens nothing and reports a diverted no-trade when none qualify", async () => {
    const svc = newService();
    spies.push(
      spyOn(CmcDataProvider.prototype, "getTrending").mockResolvedValue([
        { symbol: "CAKE", name: "PancakeSwap" },
        { symbol: "MYX", name: "MYX Finance" },
      ] as never),
    );
    spies.push(
      spyOn(svc, "researchToken").mockResolvedValue({
        bias: "neutral",
        confidence: 0.4,
        priceUsd: 1,
      }),
    );

    const r = await svc.scanAndTradeAltcoin("hourly", base);
    expect(r.traded).toBe(false);
    expect(r.diverted).toBe(true);
    expect(r.altcoinScanned).toBe(2);
    expect(r.reason).toContain("none of the top");
  });

  it("reports a diverted no-trade when nothing on the watchlist is trending", async () => {
    const svc = newService();
    spies.push(
      spyOn(CmcDataProvider.prototype, "getTrending").mockResolvedValue([
        { symbol: "WIF", name: "dogwifhat" },
        { symbol: "KGEN", name: "KGeN" },
      ] as never),
    );
    const research = spyOn(svc, "researchToken");
    spies.push(research);

    const r = await svc.scanAndTradeAltcoin("hourly", base);
    expect(r.traded).toBe(false);
    expect(r.diverted).toBe(true);
    expect(r.altcoinScanned).toBe(0);
    expect(research).not.toHaveBeenCalled(); // off-list feed → nothing researched
  });

  it("skips ETH and stablecoins in the feed (never re-buys ETH or longs the cash leg)", async () => {
    // The watchlist intentionally contains ETH + stablecoins, but this loop exists to divert
    // AWAY from ETH, and a stablecoin "long" (e.g. USDT→USDT) is degenerate. Both must be
    // dropped from the candidate pool BEFORE research, so the first REAL altcoin is chosen.
    const svc = newService();
    spies.push(
      spyOn(CmcDataProvider.prototype, "getTrending").mockResolvedValue([
        { symbol: "ETH", name: "Ethereum" }, // diverted-from asset → skip
        { symbol: "USDT", name: "Tether" }, // cash/stable leg → skip
        { symbol: "USDC", name: "USD Coin" }, // stable → skip
        { symbol: "MYX", name: "MYX Finance" }, // first real altcoin → BUY
      ] as never),
    );
    const research = spyOn(svc, "researchToken").mockResolvedValue({
      bias: "bullish",
      confidence: 0.7,
      priceUsd: 0.1,
    });
    spies.push(research);

    const r = await svc.scanAndTradeAltcoin("hourly", base);
    expect(r.traded).toBe(true);
    expect(r.tradedAsset).toBe("MYX");
    // ETH/USDT/USDC were filtered out pre-research; only MYX was ever researched.
    expect(research.mock.calls.map((c) => c[0])).toEqual(["MYX"]);

    const timers = (
      svc as never as { timers: Map<string, ReturnType<typeof setTimeout>> }
    ).timers;
    for (const h of timers.values()) clearTimeout(h);
  });
});

/**
 * The drawdown DQ-protection guardrail blocks NEW trades once equity falls ≥ RISK_MAX_DRAWDOWN_PCT
 * from its peak. That only works if the historical peak survives a restart — otherwise the peak
 * resets to 0, drawdown reads 0%, and the cap is silently disabled until equity climbs again.
 */
describe("drawdown peak survives a restart", () => {
  const SAVE = [
    "ENABLE_LIVE_TRADING",
    "COINMARKETCAP_API_KEY",
    "ASTRAEUS_STATE_DIR",
    "AUTONOMOUS_MODE",
  ];
  const saved = Object.fromEntries(SAVE.map((k) => [k, process.env[k]]));
  afterEach(() => {
    for (const k of SAVE) restoreEnv(k, saved[k]);
  });

  it("restores peakEquityUsd from the persisted schedule on resume", () => {
    process.env.ENABLE_LIVE_TRADING = "false";
    process.env.COINMARKETCAP_API_KEY ||= "test-key";
    process.env.ASTRAEUS_STATE_DIR = mkdtempSync(
      join(tmpdir(), "astraeus-dd-"),
    );

    // First run: record an equity peak and a FAR-FUTURE next cycle, then persist the schedule.
    // (Future next-cycle time → resume arms a timer instead of running a cycle: no network.)
    const svc1 = new TradingService(createMockRuntime());
    const s1 = svc1 as never as {
      peakEquityUsd: number;
      nextRunAt?: number;
      nextTimeframe?: string;
      persistSchedule: () => void;
    };
    s1.peakEquityUsd = 250;
    s1.nextRunAt = Date.now() + 6 * 3_600_000;
    s1.nextTimeframe = "daily";
    s1.persistSchedule();

    // Second run (a "restart") resumes from disk: the peak must come back, not reset to 0.
    const svc2 = new TradingService(createMockRuntime());
    expect((svc2 as never as { peakEquityUsd: number }).peakEquityUsd).toBe(0);
    svc2.startLoop(true); // resume
    expect((svc2 as never as { peakEquityUsd: number }).peakEquityUsd).toBe(
      250,
    );
    svc2.stopLoop(); // clear the armed loop/heartbeat timers
  });
});
