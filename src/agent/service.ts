import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Service, type IAgentRuntime, logger } from "@elizaos/core";
import { CmcDataProvider } from "../data/cmc";
import { PaperExecutor } from "../exec/paper";
import { TwakExecutor } from "../exec/twak";
import type { Executor, Portfolio } from "../exec/types";
import {
  generateForecast,
  type Asset,
  type ForecastTimeframe,
  type PriceForecast,
} from "../skills/options-forecast";
import { gatherForecastEnrichment } from "../skills/options-forecast/enrich";
import { parseTimeframe } from "../actions/forecast";
import { quoteX402 } from "../exec/x402";
import { checkGuardrails, shouldTakeProfit } from "../config/risk";
import { bscContractFor } from "../config/bsc-contracts";
import type { Timeframe } from "../data/cmc";
import {
  MIN_POINTS,
  readingFromTechnicals,
  synthesizeVerdict,
  type Bias,
} from "../skills/research/timeframes";
import {
  resolveTrendingWatchlist,
  trendingSearchCap,
} from "../actions/trending";
import {
  altcoinMinConfidencePct,
  altcoinQualifies,
  altcoinResearchTimeframe,
  altcoinRetryMs,
  altcoinScanDepth,
  altcoinTradesEnabled,
  altcoinUseContract,
  shouldDivertToAltcoins,
  type AltcoinCandidate,
} from "../skills/altcoin-scan/scan";
import {
  MAX_WITHDRAW_TIMELINE_MS,
  customWithdrawTimelineMs,
  withdrawTimelineMs,
} from "../skills/withdraw/timeline";
import { isStable } from "../config/tokens";

const num = (key: string, fallback: number): number => {
  const v = process.env[key];
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
};

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/** Compact human duration: "now", "45s", "12m", "4h 12m". */
const fmtDur = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s <= 0) return "now";
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
};

/** Persisted next-fire times for the loop + Track-1 heartbeat (restart-safe cadence). */
export interface ScheduleState {
  /** Epoch ms the next main-loop cycle is due. */
  loopNextAt?: number;
  /** Timeframe the next main-loop cycle should run. */
  loopTimeframe?: ForecastTimeframe;
  /** Escalation depth to restore (retry ladder position). */
  retryStep?: number;
  /** Epoch ms the next Track-1 heartbeat is due. */
  qualifyNextAt?: number;
  /** Peak portfolio equity (USD) seen so far — anchors the drawdown cap across restarts. */
  peakEquityUsd?: number;
}

/**
 * How long to wait before the next fire when RESUMING a persisted schedule after a
 * restart, so the cadence isn't corrupted by downtime:
 *   - no saved time            → `fallbackMs` (fresh schedule / run-now default)
 *   - already due (was down)   → `overdueMs`  (fire a catch-up soon)
 *   - still in the future      → the remaining time, capped at `capMs`
 * Pure + deterministic (now is injectable) so it's unit-testable.
 */
export function resumeDelayMs(
  nextAt: number | undefined,
  opts: { fallbackMs: number; overdueMs: number; capMs: number; now?: number },
): number {
  if (typeof nextAt !== "number" || !Number.isFinite(nextAt))
    return opts.fallbackMs;
  const remaining = nextAt - (opts.now ?? Date.now());
  return remaining <= 0 ? opts.overdueMs : Math.min(remaining, opts.capMs);
}

/**
 * Whether a manual forecast-and-trade should be BLOCKED: only in LIVE mode, only for a
 * non-ETH asset (BTC/BNB aren't on the competition's eligible token list, so a real buy
 * wastes USDT on something that won't count and may not route on TWAK). Gated by the
 * TRACK1_BLOCK_BTC_BNB toggle — block by default; set it to "false" to allow. Paper mode
 * and ETH are never blocked. The autonomous loop only ever trades ETH, so it's unaffected.
 */
export function isLiveTradeBlocked(
  mode: "paper" | "live",
  asset: string,
  blockToggle: string | undefined = process.env.TRACK1_BLOCK_BTC_BNB,
): boolean {
  if (mode !== "live" || asset === "ETH") return false;
  return (blockToggle ?? "true").toLowerCase() !== "false";
}

export interface OpenForecastTrade {
  id: string;
  asset: string;
  timeframe: ForecastTimeframe;
  sizeUsd: number;
  entryPrice: number;
  boughtAmount: number;
  openedAt: number;
  closeAt: number;
  /** BSC contract address (altcoin positions) so the live sell-back routes by address. */
  address?: string;
}

export interface ForecastTradeResult {
  ok: boolean;
  traded: boolean;
  timeframe: ForecastTimeframe;
  direction?: "up" | "down" | "sideways";
  confidence?: number;
  entryPrice?: number;
  sizeUsd?: number;
  closeAt?: number;
  txHash?: string;
  reason?: string;
  forecastReasoning?: string;
  /** The asset actually bought — ETH normally, or a BSC altcoin when the cycle diverted. */
  tradedAsset?: string;
  /** True when the Track-1 high-risk altcoin scan ran in place of the ETH decision. */
  diverted?: boolean;
  /** How many trending altcoins were researched during a diverted cycle. */
  altcoinScanned?: number;
}

/** One open position marked to market — entry vs current price, unrealized PnL. */
export interface OpenPositionPnL {
  id: string;
  asset: string;
  timeframe: ForecastTimeframe;
  sizeUsd: number;
  entryPrice: number;
  currentPrice: number;
  boughtAmount: number;
  currentValueUsd: number;
  pnlUsd: number;
  pnlPct: number;
  /** True if a live price was fetched (else currentPrice falls back to entry → flat PnL). */
  priced: boolean;
  openedAt: number;
  closeAt: number;
}

/** Snapshot of all open positions with aggregate mark-to-market PnL. */
export interface PositionsReport {
  positions: OpenPositionPnL[];
  totalCostUsd: number;
  totalValueUsd: number;
  totalPnlUsd: number;
  totalPnlPct: number;
  /** True if at least one position got a live price. */
  anyPriced: boolean;
}

/**
 * Status of the standalone Track-1 qualifying-trade heartbeat (the "safety loop"):
 * a guaranteed buy+sell round-trip on a fixed cadence so the agent always logs a
 * daily competition trade, INDEPENDENT of whether the forecast loop opens anything.
 */
export interface Track1SafetyLoopStatus {
  /** Whether the heartbeat is turned on (TRACK1_QUALIFY_ENABLED). */
  enabled: boolean;
  /** Round-trip size per heartbeat (USD) — independent of the loop's trade size. */
  tradeSizeUsd: number;
  /** Heartbeat cadence (ms). */
  intervalMs: number;
  /** When the next heartbeat is due (epoch ms), if one is scheduled. */
  nextRunAt?: number;
  /** True while a qualifying round-trip is currently executing. */
  inFlight: boolean;
}

export interface TradingStatus {
  running: boolean;
  symbols: string[];
  intervalMs: number;
  mode: "paper" | "live";
  tradeSizeUsd: number;
  /** Take-profit: close a position early once up this % (0/off when disabled). */
  takeProfitPct: number;
  takeProfitEnabled: boolean;
  /** Custom withdraw (auto-close) timeline override for the MAIN loop, ms (undefined = timeframe default). */
  withdrawTimelineMainMs?: number;
  /** Custom withdraw (auto-close) timeline override for the ALT loop, ms (undefined = timeframe default). */
  withdrawTimelineAltMs?: number;
  /** Base (happy-path) timeframe used for each scheduled trade. */
  baseTimeframe: ForecastTimeframe;
  /** Current escalation depth (0 = base cadence; ≥1 = on the retry ladder). */
  retryStep: number;
  /** What the next scheduled cycle will forecast, and when (epoch ms). */
  nextTimeframe?: ForecastTimeframe;
  nextRunAt?: number;
  portfolio?: Portfolio;
  openTrades: OpenForecastTrade[];
  lastResult?: ForecastTradeResult;
  /** The standalone Track-1 qualifying-trade heartbeat ("safety loop"). */
  track1: Track1SafetyLoopStatus;
}

/** One line of a TRADE_DIAGNOSTICS report. */
export interface DiagCheck {
  name: string;
  status: "pass" | "fail" | "warn" | "info";
  detail: string;
}

/** The executor used by the loop. TWAK has no price-marking; paper mode does. */
type LoopExecutor = Executor & { mark?(prices: Record<string, number>): void };

/**
 * TradingService — forecast-driven ETH spot trading, inside the agent.
 *
 * One action = forecast ETH for a timeframe; if the forecast is UP, buy a fixed
 * USD size of ETH (spot, paper) and schedule an auto-close after that timeframe
 * (hourly→1h, daily→24h, …). Autonomous mode runs this on the configured
 * interval. Swap PaperExecutor for the TWAK executor to trade live on BSC.
 */
export class TradingService extends Service {
  static serviceType = "astraeus-trading";
  capabilityDescription =
    "Forecast-driven ETH spot trading (paper): buys only when ETH is forecast UP, auto-closes after the forecast timeframe; start/stop/status.";

  private readonly rt: IAgentRuntime;
  private provider: CmcDataProvider | null = null;
  private executor: LoopExecutor | null = null;
  /** Self-rescheduling autonomous loop (replaces a fixed setInterval). */
  private loopTimer?: ReturnType<typeof setTimeout>;
  /** Standalone Track-1 qualifying-trade heartbeat (12h cadence, INDEPENDENT of the loop). */
  private qualifyTimer?: ReturnType<typeof setTimeout>;
  /** True while a qualifying round-trip is executing — prevents concurrent/double trades. */
  private qualifyInFlight = false;
  /** A qualifying BUY landed but its sell-back failed: the ETH is parked in the wallet and the
   *  NEXT cycle's pre-qualify flatten COMPLETES the round-trip (→ interval sleep) instead of
   *  opening a fresh buy. This is what stops the buy→fail-sell→buy churn. In-memory only — a
   *  restart loses it, but the startup stray-ETH sweep still flattens the orphan. */
  private qualifyBuyPending = false;
  /** True while a trading-loop cycle (forecast+trade) runs — the qualifier waits for it. */
  private cycleInFlight = false;
  /** Periodic take-profit monitor — closes a position early once it's up takeProfitPct. */
  private takeProfitTimer?: ReturnType<typeof setTimeout>;
  // --- Live risk-guardrail state (drawdown halt + per-UTC-day trade/volume caps) ---
  private peakEquityUsd = 0;
  private tradesToday = 0;
  private volumeTodayUsd = 0;
  private tradeDayKey = "";
  private loopActive = false;
  /** Escalation depth: 0 = base timeframe; ≥1 = on the retry ladder (4h, then 1h…). */
  private retryStep = 0;
  private nextRunAt?: number;
  private nextTimeframe?: ForecastTimeframe;
  /** When the next Track-1 heartbeat is due (epoch ms) — persisted so a restart resumes it. */
  private qualifyNextAt?: number;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly forecastTrades = new Map<string, OpenForecastTrade>();
  /** Per-position close-retry counter (in-memory) so a failed sell isn't dropped forever. */
  private readonly closeRetries = new Map<string, number>();
  private lastResult?: ForecastTradeResult;
  /** Where open positions are persisted so they survive an agent restart. */
  private readonly statePath: string;
  /** Where the loop + heartbeat next-fire times are persisted (restart-safe cadence). */
  private readonly schedulePath: string;

  readonly intervalMs: number;
  readonly retryMs: number;
  readonly tradeSizeUsd: number;
  /** Trade size for the standalone Track-1 qualifying heartbeat (independent of the loop's tradeSizeUsd). */
  readonly qualifyTradeSizeUsd: number;
  readonly startCashUsd: number;
  readonly autoTimeframe: ForecastTimeframe;
  readonly autoCmc: boolean;
  /** Take-profit: close a position early once it's up this %, locking in gains. */
  readonly takeProfitEnabled: boolean;
  readonly takeProfitPct: number;
  /** Custom withdraw (auto-close) timeline override for the MAIN loop, ms — undefined = use
   *  the forecast-timeframe default (AUTONOMOUS_WITHDRAW_TIMELINE_ENABLED + _TIMELINE). */
  readonly withdrawTimelineMainMs?: number;
  /** Custom withdraw (auto-close) timeline override for the ALT loop, ms — undefined = use the
   *  forecast-timeframe default (TRACK1_ALTCOIN_WITHDRAW_TIMELINE_ENABLED + _TIMELINE). */
  readonly withdrawTimelineAltMs?: number;
  /** 'live' = real on-chain swaps via TWAK; 'paper' = simulated. */
  readonly mode: "paper" | "live";

  constructor(runtime: IAgentRuntime) {
    super(runtime);
    this.rt = runtime;
    this.intervalMs = num("AUTONOMOUS_INTERVAL_MS", 43_200_000); // 12h happy-path cadence
    this.retryMs = num("AUTONOMOUS_RETRY_MS", 3_600_000); // 1h between escalation retries
    this.tradeSizeUsd = num("RISK_MAX_TRADE_USD", 5);
    this.qualifyTradeSizeUsd = num("TRACK1_QUALIFY_TRADE_USD", 1.5);
    this.startCashUsd = num("PAPER_START_CASH_USD", 15);
    this.autoTimeframe = parseTimeframe(
      process.env.AUTONOMOUS_TIMEFRAME ?? "daily",
    );
    this.autoCmc = /\bcmc\b/i.test(process.env.AUTONOMOUS_MODE ?? "");
    this.takeProfitEnabled =
      (process.env.RISK_TAKE_PROFIT_ENABLED ?? "false").toLowerCase() ===
      "true";
    this.takeProfitPct = num("RISK_TAKE_PROFIT_PCT", 10);
    // Custom withdraw timelines (ms) — snapshot the per-loop overrides for status/diagnostics;
    // the hot path re-reads them live via withdrawTimelineMs() at each trade.
    this.withdrawTimelineMainMs = customWithdrawTimelineMs("main");
    this.withdrawTimelineAltMs = customWithdrawTimelineMs("alt");
    // Live trading requires an explicit opt-in. Until then, paper mode.
    this.mode =
      (process.env.ENABLE_LIVE_TRADING ?? "").toLowerCase() === "true"
        ? "live"
        : "paper";
    const stateDir =
      process.env.ASTRAEUS_STATE_DIR?.trim() || join(process.cwd(), "data");
    // Scope the open-position ledger by mode so paper positions can NEVER be
    // reconciled (and sold for real) after switching ENABLE_LIVE_TRADING on.
    this.statePath = join(stateDir, `open-trades-${this.mode}.json`);
    this.schedulePath = join(stateDir, `schedule-${this.mode}.json`);
    try {
      this.provider = new CmcDataProvider();
      this.executor =
        this.mode === "live"
          ? new TwakExecutor({
              chain: "bsc",
              stableSymbol: "USDT",
              defaultSlippagePct: num("RISK_MAX_SLIPPAGE_BPS", 100) / 100,
              // Single source of truth for contract-vs-symbol routing: the SAME
              // TRACK1_ALTCOIN_USE_CONTRACT read the scan uses to gate the address,
              // so the executor and the service can never disagree on it.
              useContract: altcoinUseContract(),
            })
          : new PaperExecutor({
              startingCashUsd: this.startCashUsd,
              stableSymbol: "USDT",
              persistPath: join(stateDir, "paper-portfolio.json"),
            });
      logger.info(
        { mode: this.mode },
        `TradingService: executor = ${this.mode === "live" ? "TWAK (live BSC)" : "paper"}`,
      );
    } catch (e) {
      logger.warn(
        { err: e instanceof Error ? e.message : String(e) },
        "TradingService: not initialized (is COINMARKETCAP_API_KEY set?)",
      );
    }
  }

  static async start(runtime: IAgentRuntime): Promise<TradingService> {
    const service = new TradingService(runtime);
    // Recover any positions left open by a previous run before (re)starting the loop.
    service.reconcileOpenTrades();
    // Flatten any ETH a prior Track-1 round-trip bought but failed to sell back (an orphan
    // the position ledger doesn't track) so it can't sit unsold across restarts.
    service.sweepStrayEthOnStartup();
    if (/\b(trade|auto|on|true)\b/i.test(process.env.AUTONOMOUS_MODE ?? "")) {
      // Boot auto-start RESUMES the persisted loop + heartbeat cadence (restart-safe).
      const r = service.startLoop(true);
      logger.info(
        { started: r.ok, reason: r.reason },
        "TradingService: AUTONOMOUS_MODE auto-start",
      );
    }
    return service;
  }

  static async stop(runtime: IAgentRuntime): Promise<void> {
    const service = runtime.getService(
      TradingService.serviceType,
    ) as unknown as TradingService | null;
    service?.shutdown();
  }

  async stop(): Promise<void> {
    this.shutdown();
  }

  private shutdown(): void {
    this.stopLoop();
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  get running(): boolean {
    return this.loopActive;
  }

  get symbols(): string[] {
    return ["ETH"];
  }

  /**
   * Forecast ETH for a timeframe and, ONLY if the forecast is UP, open a fixed-size
   * ETH/USDT spot buy that auto-closes after the timeframe.
   */
  async forecastAndTrade(
    timeframe: ForecastTimeframe,
    useCmc: boolean,
    asset: Asset = "ETH",
  ): Promise<ForecastTradeResult> {
    if (!this.executor || !this.provider) {
      const r: ForecastTradeResult = {
        ok: false,
        traded: false,
        timeframe,
        reason: "service not initialized (COINMARKETCAP_API_KEY?)",
      };
      this.lastResult = r;
      return r;
    }
    // `asset` is BTC/ETH/BNB (defaults to ETH for the autonomous loop). The position
    // it opens auto-closes after `timeframe` and is restart-safe (persisted + reconciled).
    // Live-mode safety: refuse a real BTC/BNB buy (ineligible for the competition) BEFORE
    // spending any forecast credits — toggle with TRACK1_BLOCK_BTC_BNB (block by default).
    if (isLiveTradeBlocked(this.mode, asset)) {
      const r: ForecastTradeResult = {
        ok: false,
        traded: false,
        timeframe,
        reason: `${asset} is not on the competition's eligible token list — blocked in LIVE mode (set TRACK1_BLOCK_BTC_BNB=false to override). ETH is eligible.`,
      };
      this.lastResult = r;
      return r;
    }
    // Supplementary context (CMC options-positioning + technicals/regime + x402), all
    // bounded/best-effort/parallel; options/derivatives data stays the PRIMARY ~60% basis.
    const extraContext = await gatherForecastEnrichment(
      this.rt,
      this.provider,
      asset,
      useCmc,
    );
    const f = await generateForecast(asset, timeframe, extraContext);
    // Publish the latest forecast for the (optional, decoupled) ERC-8183 sidecar.
    this.persistLatestForecast(f);
    const base: ForecastTradeResult = {
      ok: true,
      traded: false,
      timeframe,
      direction: f.prediction.direction,
      confidence: f.prediction.confidence,
      entryPrice: f.currentPrice,
      forecastReasoning: f.reasoning,
    };

    // Track 1 — high-risk altcoin trades (opt-in). When enabled and the ETH forecast is
    // BULLISH (up) or SIDEWAYS, divert this cycle: instead of the normal ETH decision (which
    // would BUY on a confident UP and SKIP on sideways), hunt the trending BSC watchlist for
    // a bullish altcoin and buy that. So with the toggle on, a would-be ETH buy is REPLACED
    // by the altcoin hunt. Only ETH cycles divert (manual BTC/BNB are unaffected).
    if (
      asset === "ETH" &&
      altcoinTradesEnabled() &&
      shouldDivertToAltcoins(f.prediction.direction)
    ) {
      return this.scanAndTradeAltcoin(timeframe, base);
    }

    // Trade only on a confident UP call: direction must be UP and conviction ≥ the
    // configured minimum (RISK_MIN_CONVICTION, 0–100). Forecast confidence is 0–1.
    const minConvictionPct = num("RISK_MIN_CONVICTION", 60);
    const convictionPct = (f.prediction.confidence ?? 0) * 100;
    if (f.prediction.direction !== "up" || convictionPct < minConvictionPct) {
      const reason =
        f.prediction.direction !== "up"
          ? `forecast is ${f.prediction.direction.toUpperCase()} — only buys when UP`
          : `conviction ${convictionPct.toFixed(0)}% < ${minConvictionPct}% minimum`;
      const r = { ...base, reason };
      this.lastResult = r;
      return r;
    }

    const sizeUsd = this.tradeSizeUsd;
    const price = f.currentPrice;
    this.executor.mark?.({ [asset]: price });
    const pf = await this.executor.getPortfolio();
    if (pf.cashUsd < sizeUsd) {
      const r = {
        ...base,
        reason: `insufficient cash ($${pf.cashUsd.toFixed(2)} < $${sizeUsd})`,
      };
      this.lastResult = r;
      return r;
    }

    // Hard pre-trade guardrails (drawdown halt + daily trade/volume caps). The
    // competition DQs past ~30% drawdown, so we stop opening positions well before
    // that. Spot-only + $5 size already cap downside; this is the second line.
    this.rolloverDay();
    this.peakEquityUsd = Math.max(this.peakEquityUsd, pf.totalValueUsd);
    const drawdownPct =
      this.peakEquityUsd > 0
        ? ((this.peakEquityUsd - pf.totalValueUsd) / this.peakEquityUsd) * 100
        : 0;
    const guard = checkGuardrails({
      conviction: convictionPct,
      tradeUsd: sizeUsd,
      currentDrawdownPct: drawdownPct,
      tradesToday: this.tradesToday,
      volumeTodayUsd: this.volumeTodayUsd,
      tokenSymbol: asset,
      isTokenEligible: true,
    });
    if (!guard.allowed) {
      logger.warn({ reason: guard.reason }, "trade blocked by risk guardrail");
      const r = { ...base, reason: `guardrail: ${guard.reason}` };
      this.lastResult = r;
      return r;
    }

    const swap = await this.executor.swap({
      fromSymbol: "USDT",
      toSymbol: asset,
      amountUsd: sizeUsd,
      maxSlippageBps: num("RISK_MAX_SLIPPAGE_BPS", 100),
    });
    if (!swap.ok) {
      const r = { ...base, ok: false, reason: swap.error };
      this.lastResult = r;
      return r;
    }

    const id = `ft-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4).toString(36)}`;
    const boughtAmount = sizeUsd / price;
    // Hold this MAIN-loop position for the custom withdraw timeline when switched on
    // (AUTONOMOUS_WITHDRAW_TIMELINE_ENABLED + _TIMELINE), else the forecast-timeframe default.
    // One value drives BOTH closeAt and the auto-close timer so they can never disagree.
    const holdMs = withdrawTimelineMs("main", timeframe);
    const closeAt = Date.now() + holdMs;
    this.forecastTrades.set(id, {
      id,
      asset,
      timeframe,
      sizeUsd,
      entryPrice: price,
      boughtAmount,
      openedAt: Date.now(),
      closeAt,
    });
    this.persistOpenTrades();
    this.timers.set(
      id,
      setTimeout(() => {
        this.closeForecastTrade(id).catch((e) =>
          logger.error({ err: String(e) }, "forecast trade close failed"),
        );
      }, holdMs),
    );

    const r: ForecastTradeResult = {
      ...base,
      traded: true,
      sizeUsd,
      closeAt,
      txHash: swap.txHash,
    };
    this.lastResult = r;
    this.tradesToday += 1; // count toward the daily guardrail caps
    this.volumeTodayUsd += sizeUsd;
    logger.info(
      {
        id,
        timeframe,
        entry: price.toFixed(2),
        sizeUsd,
        closeAt: new Date(closeAt).toISOString(),
      },
      "forecast trade OPENED",
    );
    return r;
  }

  /**
   * Deterministic single-timeframe research read for one token — the "research feature"
   * the altcoin scan runs per candidate. Pulls the token's live price + CMC technicals for
   * `tf` and blends them into a bias/confidence via the same synthesizeVerdict core the
   * RESEARCH card uses (no LLM, no skills → fast and credit-cheap for a tight scan loop).
   * Returns a zero-confidence neutral when data is missing rather than throwing.
   */
  async researchToken(
    symbol: string,
    tf: Timeframe,
  ): Promise<{ bias: Bias; confidence: number; priceUsd: number }> {
    if (!this.provider) return { bias: "neutral", confidence: 0, priceUsd: 0 };
    const [sigs, tech] = await Promise.all([
      this.provider.getTokenSignals([symbol]).catch(() => []),
      this.provider.getTimeframeTechnicals(symbol, tf).catch(() => undefined),
    ]);
    const priceUsd = sigs[0]?.priceUsd ?? 0;
    if (!tech || tech.points < MIN_POINTS) {
      return { bias: "neutral", confidence: 0, priceUsd };
    }
    const verdict = synthesizeVerdict(
      [readingFromTechnicals(tf, tech)],
      priceUsd,
    );
    return { bias: verdict.bias, confidence: verdict.confidence, priceUsd };
  }

  /**
   * Track 1 — high-risk altcoin trades. Search the trending feed (filtered to the eligible
   * BSC watchlist via resolveTrendingWatchlist, so buys can only land on the competition
   * allowlist), research the top {@link altcoinScanDepth} tokens one at a time on the
   * configured timeframe, and BUY the first whose research is bullish with confidence ≥
   * {@link altcoinMinConfidencePct}. Opens a normal auto-closing forecast position (the live
   * swap routes by the resolved BSC contract address). If none qualify, opens nothing and
   * returns a DIVERTED no-trade result — the loop then retries after {@link altcoinRetryMs}.
   */
  async scanAndTradeAltcoin(
    timeframe: ForecastTimeframe,
    base: ForecastTradeResult,
  ): Promise<ForecastTradeResult> {
    if (!this.executor || !this.provider) {
      const r = { ...base, diverted: true, reason: "service not initialized" };
      this.lastResult = r;
      return r;
    }
    const depth = altcoinScanDepth();
    const minPct = altcoinMinConfidencePct();
    const tf = altcoinResearchTimeframe();

    // Trending → keep ONLY the eligible BSC watchlist symbols (TRACK1_TRENDING_WATCHLIST /
    // the baked-in 146-token default). Filtering here is UNCONDITIONAL — it does NOT depend
    // on TRACK1_TRENDING_WATCHLIST_FILTER (that toggle only governs the TRENDING display
    // action); this is the hard guardrail that keeps altcoin buys on the eligible list.
    const watchlist = resolveTrendingWatchlist("");
    let candidates: string[] = [];
    try {
      const fetched = await this.provider.getTrending(trendingSearchCap());
      candidates = fetched
        .map((t) => (t.symbol ?? "").toUpperCase())
        // Keep only eligible-watchlist symbols, and EXCLUDE the cash/stable leg and ETH:
        // this loop exists to divert AWAY from ETH, so re-buying ETH defeats the purpose,
        // and a stablecoin "long" (e.g. a degenerate USDT→USDT swap) is never a real trade.
        .filter((s) => s && watchlist.has(s) && s !== "ETH" && !isStable(s));
    } catch (e) {
      const r = {
        ...base,
        diverted: true,
        reason: `altcoin scan: trending fetch failed (${e instanceof Error ? e.message : String(e)})`,
      };
      this.lastResult = r;
      return r;
    }

    // Research candidates in trending order; STOP at the first bullish ≥ minPct.
    let scanned = 0;
    let chosen: AltcoinCandidate | undefined;
    for (const symbol of candidates.slice(0, depth)) {
      scanned += 1;
      let cand: AltcoinCandidate;
      try {
        const v = await this.researchToken(symbol, tf);
        cand = {
          symbol,
          priceUsd: v.priceUsd,
          bias: v.bias,
          confidence: v.confidence,
        };
      } catch {
        cand = { symbol, priceUsd: 0, bias: "neutral", confidence: 0 };
      }
      if (altcoinQualifies(cand, minPct)) {
        chosen = cand;
        break;
      }
    }

    if (!chosen) {
      const r: ForecastTradeResult = {
        ...base,
        traded: false,
        diverted: true,
        altcoinScanned: scanned,
        reason:
          scanned === 0
            ? "altcoin scan: no trending tokens on the BSC watchlist right now — will retry"
            : `altcoin scan: none of the top ${scanned} trending BSC altcoins were bullish ≥ ${minPct}% on ${tf} — will retry`,
      };
      this.lastResult = r;
      return r;
    }

    // BSC contract for the live swap comes from the BAKED map (src/config/bsc-contracts.ts) —
    // NO per-trade CMC call. This routes the swap by the exact on-chain address instead of the
    // chain-ambiguous ticker (the bug behind generic altcoin symbols). Unmapped symbols
    // (TON/H/IP/USDF — no canonical BSC token) → undefined → TWAK falls back to the ticker.
    const address = altcoinUseContract()
      ? bscContractFor(chosen.symbol)
      : undefined;

    const sizeUsd = this.tradeSizeUsd;
    const price = chosen.priceUsd;
    this.executor.mark?.({ [chosen.symbol]: price });
    const pf = await this.executor.getPortfolio();
    if (pf.cashUsd < sizeUsd) {
      const r = {
        ...base,
        diverted: true,
        altcoinScanned: scanned,
        reason: `altcoin scan: picked ${chosen.symbol} but cash $${pf.cashUsd.toFixed(2)} < $${sizeUsd}`,
      };
      this.lastResult = r;
      return r;
    }

    // Same hard guardrails as the ETH path (drawdown halt + daily trade/volume caps).
    this.rolloverDay();
    this.peakEquityUsd = Math.max(this.peakEquityUsd, pf.totalValueUsd);
    const drawdownPct =
      this.peakEquityUsd > 0
        ? ((this.peakEquityUsd - pf.totalValueUsd) / this.peakEquityUsd) * 100
        : 0;
    const guard = checkGuardrails({
      conviction: chosen.confidence * 100,
      tradeUsd: sizeUsd,
      currentDrawdownPct: drawdownPct,
      tradesToday: this.tradesToday,
      volumeTodayUsd: this.volumeTodayUsd,
      tokenSymbol: chosen.symbol,
      isTokenEligible: true, // already filtered to the eligible BSC watchlist
    });
    if (!guard.allowed) {
      logger.warn(
        { reason: guard.reason, symbol: chosen.symbol },
        "altcoin trade blocked by risk guardrail",
      );
      const r = {
        ...base,
        diverted: true,
        altcoinScanned: scanned,
        reason: `altcoin scan: ${chosen.symbol} blocked — guardrail: ${guard.reason}`,
      };
      this.lastResult = r;
      return r;
    }

    const swap = await this.executor.swap({
      fromSymbol: "USDT",
      toSymbol: chosen.symbol,
      toAddress: address,
      amountUsd: sizeUsd,
      maxSlippageBps: num("RISK_MAX_SLIPPAGE_BPS", 100),
    });
    if (!swap.ok) {
      const r = {
        ...base,
        ok: false,
        diverted: true,
        altcoinScanned: scanned,
        reason: `altcoin scan: ${chosen.symbol} buy failed — ${swap.error}`,
      };
      this.lastResult = r;
      return r;
    }

    const id = `ft-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4).toString(36)}`;
    const boughtAmount = sizeUsd / price;
    // Hold this ALT-loop position for the custom withdraw timeline when switched on
    // (TRACK1_ALTCOIN_WITHDRAW_TIMELINE_ENABLED + _TIMELINE), else the forecast-timeframe
    // default — independent of the main loop's override. One value drives closeAt + the timer.
    const holdMs = withdrawTimelineMs("alt", timeframe);
    const closeAt = Date.now() + holdMs;
    this.forecastTrades.set(id, {
      id,
      asset: chosen.symbol,
      timeframe,
      sizeUsd,
      entryPrice: price,
      boughtAmount,
      openedAt: Date.now(),
      closeAt,
      address,
    });
    this.persistOpenTrades();
    this.timers.set(
      id,
      setTimeout(() => {
        this.closeForecastTrade(id).catch((e) =>
          logger.error({ err: String(e) }, "altcoin trade close failed"),
        );
      }, holdMs),
    );

    this.tradesToday += 1; // count toward the daily guardrail caps
    this.volumeTodayUsd += sizeUsd;
    const r: ForecastTradeResult = {
      ...base,
      traded: true,
      diverted: true,
      tradedAsset: chosen.symbol,
      direction: "up",
      confidence: chosen.confidence,
      entryPrice: price,
      sizeUsd,
      closeAt,
      txHash: swap.txHash,
      altcoinScanned: scanned,
      reason: `Track 1 high-risk altcoin: bought ${chosen.symbol} (research bullish ${(chosen.confidence * 100).toFixed(0)}% on ${tf})`,
    };
    this.lastResult = r;
    logger.info(
      {
        id,
        symbol: chosen.symbol,
        address,
        entry: price,
        sizeUsd,
        confidence: chosen.confidence,
        scanned,
        closeAt: new Date(closeAt).toISOString(),
      },
      "altcoin trade OPENED (Track 1 high-risk)",
    );
    return r;
  }

  /** Close (sell) a forecast position back to USDT at the current price. */
  private async closeForecastTrade(id: string): Promise<void> {
    const t = this.forecastTrades.get(id);
    if (!t || !this.executor || !this.provider) return;
    // Claim the position SYNCHRONOUSLY — before any await — so concurrent closers
    // (the auto-close timer, the take-profit monitor, close-all, and the overdue
    // reconcile) can't each pass the guard above and sell the same position twice.
    // Whoever deletes it first owns the sell; the others no-op on the early return.
    this.forecastTrades.delete(id);
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
    this.persistOpenTrades();

    // The CURRENT market price at the sell-off moment — NEVER the entry price we bought at.
    // CMC's quote service is intermittently flaky, so RETRY the live quote several times
    // (CLOSE_PRICE_RETRIES, default 5) before giving up on it — only then do we fall back to
    // the on-chain valuation (and the entry price as a last resort). Applies to ETH and
    // altcoin closes alike (this is the shared close path).
    let price = 0;
    const priceRetries = Math.max(1, Math.trunc(num("CLOSE_PRICE_RETRIES", 5)));
    const priceRetryMs = num("CLOSE_PRICE_RETRY_MS", 1500);
    for (let attempt = 1; attempt <= priceRetries; attempt++) {
      try {
        const sig = await this.provider.getTokenSignals([t.asset]);
        price = sig[0]?.priceUsd ?? 0;
      } catch {
        price = 0;
      }
      if (price > 0) break;
      if (attempt < priceRetries) await sleep(priceRetryMs);
    }

    // Read the position LIVE from the wallet on-chain: how much of the token we actually hold
    // and what it's worth RIGHT NOW. `boughtAmount` is the IDEAL fill (sizeUsd/price); the
    // wallet received LESS (the buy paid a DEX fee + slippage), so selling `boughtAmount` worth
    // would request MORE than is held and a live swap would reject it for insufficient balance
    // — leaving the position stuck open. So cap at the real on-chain balance.
    let held = 0;
    let heldValueUsd = 0;
    try {
      const pf = await this.executor.getPortfolio();
      const h = pf.holdings.find((x) => x.symbol === t.asset);
      held = h?.amount ?? 0;
      heldValueUsd = h?.valueUsd ?? 0;
    } catch {
      /* no balance read — fall back to boughtAmount (still haircut-shaved below) */
    }

    // Price used to SIZE the sell, in priority order: the live market quote → the position's
    // CURRENT on-chain worth (wallet value ÷ amount) at this moment → only as a last resort,
    // the entry price. The buy price is never the primary basis — the exit is sized off what
    // the position is worth NOW, checked on-chain, not what we paid for it.
    if (!(price > 0) && held > 0 && heldValueUsd > 0)
      price = heldValueUsd / held;
    if (!(price > 0)) price = t.entryPrice;
    this.executor.mark?.({ [t.asset]: price });

    // Cap the sell at the real on-chain balance and shave a small haircut to absorb any price
    // tick / rounding between this read and the swap. (Paper caps internally; this protects live.)
    const sellAmount =
      held > 0 ? Math.min(t.boughtAmount, held) : t.boughtAmount;
    const haircut = 1 - num("CLOSE_SELL_HAIRCUT_BPS", 50) / 10_000; // default 0.5%
    const swap = await this.executor.swap({
      fromSymbol: t.asset,
      toSymbol: "USDT",
      // Route altcoin sell-backs by contract address (tickers collide across chains); ETH
      // has no stored address so this is undefined and TWAK falls back to the symbol.
      fromAddress: t.address,
      amountUsd: sellAmount * price * haircut,
      maxSlippageBps: num("RISK_MAX_SLIPPAGE_BPS", 100),
    });
    const pnlUsd = (price - t.entryPrice) * sellAmount;

    if (!swap.ok) {
      // The sell did NOT execute — the asset is still in the wallet. The position was
      // removed up-front (to block a double-sell); leaving it gone ORPHANS real funds
      // (we'd think we're flat but still hold it). Re-track it and re-arm a bounded
      // retry. swap() already retries transient TWAK blips internally, so a failure
      // here is usually a real revert/funds issue — cap the retries to avoid a loop;
      // once exhausted it stays tracked for close-all / restart-reconcile to handle.
      const attempts = (this.closeRetries.get(id) ?? 0) + 1;
      const maxAttempts = Math.max(1, num("CLOSE_MAX_RETRIES", 5));
      this.forecastTrades.set(id, t);
      this.persistOpenTrades();
      if (attempts < maxAttempts) {
        this.closeRetries.set(id, attempts);
        const retryMs = num("CLOSE_RETRY_MS", 60_000);
        this.timers.set(
          id,
          setTimeout(() => {
            this.closeForecastTrade(id).catch((e) =>
              logger.error(
                { err: String(e), id },
                "forecast trade close retry failed",
              ),
            );
          }, retryMs),
        );
      } else {
        this.closeRetries.delete(id);
      }
      logger.error(
        { id, err: swap.error, attempt: attempts },
        "forecast trade close FAILED — re-tracked to avoid orphaning funds",
      );
      return;
    }
    this.closeRetries.delete(id);

    logger.info(
      {
        id,
        timeframe: t.timeframe,
        entry: t.entryPrice.toFixed(2),
        exit: price.toFixed(2),
        pnlUsd: pnlUsd.toFixed(2),
        ok: swap.ok,
        txHash: swap.txHash,
      },
      "forecast trade CLOSED",
    );
  }

  /**
   * Manually close (sell) EVERY open ETH position back to USDT — the "close all
   * positions" command. Cancels each position's auto-close timer and sells now.
   */
  async closeAllPositions(): Promise<{ closed: number; ids: string[] }> {
    const ids = [...this.forecastTrades.keys()];
    for (const id of ids) {
      await this.closeForecastTrade(id).catch((e) =>
        logger.error({ err: String(e), id }, "close-all: close failed"),
      );
    }
    logger.info({ closed: ids.length }, "closed all positions on request");
    return { closed: ids.length, ids };
  }

  /** Write the open-position ledger to disk (best-effort; never breaks trading). */
  private persistOpenTrades(): void {
    try {
      mkdirSync(dirname(this.statePath), { recursive: true });
      writeFileSync(
        this.statePath,
        JSON.stringify([...this.forecastTrades.values()], null, 2),
      );
    } catch (e) {
      logger.warn(
        { err: e instanceof Error ? e.message : String(e) },
        "could not persist open trades",
      );
    }
  }

  /**
   * Publish the latest forecast to a shared file so the optional ERC-8183 sidecar
   * can serve it as an on-chain paid job. Best-effort, synchronous, try/catch —
   * a disk error here can never affect a forecast or trade.
   */
  private persistLatestForecast(f: PriceForecast): void {
    // Only publish for the ERC-8183 sidecar when explicitly enabled (off by default).
    if ((process.env.ERC8183_SIDECAR_ENABLED ?? "").toLowerCase() !== "true")
      return;
    try {
      const dir = dirname(this.statePath);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "latest-forecast.json"),
        JSON.stringify(
          {
            asset: f.asset,
            timeframe: f.timeframe,
            direction: f.prediction.direction,
            confidence: f.prediction.confidence,
            currentPrice: f.currentPrice,
            targetPrice: f.prediction.targetPrice,
            priceChange: f.prediction.priceChange,
            reasoning: f.reasoning,
            timestamp: Date.now(),
          },
          null,
          2,
        ),
      );
    } catch {
      /* best-effort; never blocks trading */
    }
  }

  /** Read the persisted open-position ledger (empty if missing/corrupt). */
  private loadOpenTrades(): OpenForecastTrade[] {
    try {
      if (!existsSync(this.statePath)) return [];
      const arr = JSON.parse(readFileSync(this.statePath, "utf8"));
      return Array.isArray(arr) ? (arr as OpenForecastTrade[]) : [];
    } catch (e) {
      logger.warn(
        { err: e instanceof Error ? e.message : String(e) },
        "could not load open trades",
      );
      return [];
    }
  }

  /**
   * Restart safety: on startup, restore positions left open by a previous run.
   * Any position already past its close time is closed immediately; the rest get
   * their auto-close timer re-armed for the remaining time. Without this, a daily
   * or weekly position would be orphaned across a restart (timers are in-memory).
   */
  reconcileOpenTrades(): void {
    if (!this.executor) return;
    const saved = this.loadOpenTrades();
    if (saved.length === 0) return;
    let rearmed = 0;
    let overdue = 0;
    for (const t of saved) {
      this.forecastTrades.set(t.id, t);
      const remaining = t.closeAt - Date.now();
      if (remaining <= 0) {
        overdue += 1;
        // Past due — close now (fire-and-forget so startup isn't blocked on the network).
        this.closeForecastTrade(t.id).catch((e) =>
          logger.error(
            { err: String(e), id: t.id },
            "reconcile: overdue close failed",
          ),
        );
      } else {
        rearmed += 1;
        // Clamp the re-armed delay to the 32-bit setTimeout ceiling: a far-future closeAt
        // (e.g. a long custom withdraw timeline) would otherwise overflow and fire instantly.
        this.timers.set(
          t.id,
          setTimeout(
            () => {
              this.closeForecastTrade(t.id).catch((e) =>
                logger.error({ err: String(e) }, "forecast trade close failed"),
              );
            },
            Math.min(remaining, MAX_WITHDRAW_TIMELINE_MS),
          ),
        );
      }
    }
    logger.info(
      { total: saved.length, rearmed, overdue },
      "reconciled open forecast trades on startup",
    );
  }

  /**
   * Autonomous loop with escalation.
   *
   * Happy path: every {@link intervalMs} (12h) run a forecast-and-trade on the base
   * timeframe ({@link autoTimeframe}, default daily). If that attempt is UNSUCCESSFUL
   * (ETH not forecast UP with sufficient conviction), the unsuccessful attempt does
   * NOT consume the daily slot — instead the agent retries on a shorter horizon after
   * {@link retryMs} (1h): daily-fail → 4h, then → 1h, then 1h… repeatedly until a
   * trade actually opens, after which it resets to the 12h base cadence.
   */
  /**
   * Start the loop. `resume=true` (used on a restart/boot) RESUMES the persisted
   * cadence so downtime doesn't corrupt it: an overdue cycle/heartbeat fires soon
   * (catch-up), one still in the future waits out only its remaining time, and the
   * Track-1 18h heartbeat is no longer reset to a fresh 18h on every restart (which
   * could starve it under frequent restarts and miss the daily-trade guarantee).
   * `resume=false` (manual "start auto") starts fresh: a cycle now, heartbeat 1 interval out.
   */
  startLoop(resume = false): { ok: boolean; reason?: string } {
    if (!this.executor)
      return { ok: false, reason: "not initialized (COINMARKETCAP_API_KEY?)" };
    if (this.loopActive) return { ok: false, reason: "already running" };
    this.loopActive = true;
    this.retryStep = 0;
    const saved = resume ? this.loadSchedule() : {};

    // Restore the historical equity peak so the drawdown cap survives a restart — without
    // this the peak resets to 0 and the agent reports 0% drawdown until equity climbs to a
    // fresh peak, silently disabling the DQ-protection guardrail after every restart.
    if (
      resume &&
      typeof saved.peakEquityUsd === "number" &&
      saved.peakEquityUsd > 0
    ) {
      this.peakEquityUsd = saved.peakEquityUsd;
    }

    // Main loop: resume the persisted cadence (catch up if a cycle came due while we
    // were down; otherwise wait the remainder). Fresh start / no saved time → run now.
    const loopTf = saved.loopTimeframe ?? this.autoTimeframe;
    if (typeof saved.retryStep === "number") this.retryStep = saved.retryStep;
    const loopDelay = resumeDelayMs(saved.loopNextAt, {
      fallbackMs: 0, // no saved schedule → run a cycle immediately
      overdueMs: 0, // was due during downtime → run immediately (catch up)
      capMs: this.intervalMs,
    });
    if (loopDelay <= 0) {
      void this.runCycle(loopTf);
    } else {
      this.nextTimeframe = loopTf;
      this.nextRunAt = Date.now() + loopDelay;
      this.persistSchedule();
      this.loopTimer = setTimeout(() => void this.runCycle(loopTf), loopDelay);
    }

    // Track-1 heartbeat: resume its persisted next-fire (overdue → catch-up soon).
    const interval = num("TRACK1_QUALIFY_INTERVAL_MS", 43_200_000);
    const heartbeatDelay = resumeDelayMs(saved.qualifyNextAt, {
      fallbackMs: interval, // fresh / no saved → first one a full interval out
      overdueMs: Math.min(num("TRACK1_QUALIFY_RETRY_MS", 300_000), 30_000),
      capMs: interval,
    });
    this.scheduleQualifyCycle(heartbeatDelay);

    // Start the take-profit monitor (no-op unless RISK_TAKE_PROFIT_ENABLED=true).
    this.scheduleTakeProfitCheck();

    // Eyeball line: after a restart this shows the RESUMED cadence, not a fresh reset.
    const heartbeatOn =
      (process.env.TRACK1_QUALIFY_ENABLED ?? "false").toLowerCase() === "true";
    logger.info(
      {
        resumed: resume,
        mode: this.mode,
        nextLoop: loopDelay <= 0 ? "now" : fmtDur(loopDelay),
        nextHeartbeat: heartbeatOn ? fmtDur(heartbeatDelay) : "off",
      },
      `Astraeus loop started (${this.mode}) — next loop ${loopDelay <= 0 ? "now" : `in ${fmtDur(loopDelay)}`} · next Track-1 heartbeat ${heartbeatOn ? `in ${fmtDur(heartbeatDelay)}` : "off"}`,
    );
    return { ok: true };
  }

  stopLoop(): boolean {
    if (!this.loopActive) return false;
    this.loopActive = false;
    if (this.loopTimer) {
      clearTimeout(this.loopTimer);
      this.loopTimer = undefined;
    }
    this.clearQualifyTimer();
    this.clearTakeProfitTimer();
    this.nextRunAt = undefined;
    this.nextTimeframe = undefined;
    return true;
  }

  /** Re-arm the periodic take-profit monitor (off entirely unless enabled). */
  private scheduleTakeProfitCheck(): void {
    if (!this.loopActive || !this.takeProfitEnabled) return;
    this.clearTakeProfitTimer();
    const ms = num("RISK_TAKE_PROFIT_CHECK_MS", 300_000); // 5 min
    this.takeProfitTimer = setTimeout(() => {
      void this.checkTakeProfit().finally(() => this.scheduleTakeProfitCheck());
    }, ms);
  }

  private clearTakeProfitTimer(): void {
    if (this.takeProfitTimer) {
      clearTimeout(this.takeProfitTimer);
      this.takeProfitTimer = undefined;
    }
  }

  /**
   * Take-profit monitor — the OPPOSITE of the drawdown halt. Closes EARLY any open
   * position whose unrealized gain has reached takeProfitPct, locking in the profit
   * instead of waiting out the timeframe. Best-effort: never throws, never blocks the loop.
   *
   * Each position is priced against its OWN asset (an altcoin must be valued at the
   * altcoin's price, never ETH's) — batched into one quotes call for the distinct held
   * assets. An asset whose price can't be read is left untouched (we don't act blind).
   */
  async checkTakeProfit(): Promise<number> {
    if (!this.takeProfitEnabled || !this.provider || !this.executor) return 0;
    if (this.forecastTrades.size === 0) return 0;
    const assets = [
      ...new Set([...this.forecastTrades.values()].map((t) => t.asset)),
    ];
    const prices: Record<string, number> = {};
    try {
      const sigs = await this.provider.getTokenSignals(assets);
      for (const s of sigs)
        if (s?.symbol && s.priceUsd > 0) prices[s.symbol] = s.priceUsd;
    } catch {
      return 0; // no prices → don't act
    }
    if (Object.keys(prices).length === 0) return 0;
    this.executor.mark?.(prices);
    let closed = 0;
    for (const [id, t] of [...this.forecastTrades]) {
      const price = prices[t.asset];
      if (!(price > 0)) continue; // couldn't price this asset → leave the position be
      if (shouldTakeProfit(t.entryPrice, price, this.takeProfitPct)) {
        const gainPct = ((price - t.entryPrice) / t.entryPrice) * 100;
        logger.info(
          {
            id,
            asset: t.asset,
            entry: t.entryPrice,
            price,
            gainPct: gainPct.toFixed(1),
          },
          `take-profit hit (+${this.takeProfitPct}%) — closing position early`,
        );
        await this.closeForecastTrade(id).catch((e) =>
          logger.error({ err: String(e), id }, "take-profit close failed"),
        );
        closed += 1;
      }
    }
    return closed;
  }

  /** Run one forecast-and-trade, then schedule the next cycle per the escalation rules. */
  private async runCycle(timeframe: ForecastTimeframe): Promise<void> {
    if (!this.loopActive) return;
    this.nextRunAt = undefined;
    this.nextTimeframe = undefined;

    let success = false;
    let diverted = false;
    this.cycleInFlight = true; // the qualifying heartbeat defers while this runs
    try {
      const r = await this.forecastAndTrade(timeframe, this.autoCmc);
      success = r.traded === true;
      diverted = r.diverted === true;
    } catch (e) {
      logger.error({ err: String(e) }, "autonomous forecast-trade failed");
      success = false; // treat an error as unsuccessful → retry on the ladder
    } finally {
      this.cycleInFlight = false;
    }
    if (!this.loopActive) return;

    // Decide the next cycle from this one's outcome.
    let nextTf: ForecastTimeframe;
    let delayMs: number;
    if (success) {
      this.retryStep = 0;
      nextTf = this.autoTimeframe;
      delayMs = this.intervalMs;
    } else if (diverted) {
      // The Track-1 altcoin scan ran but opened nothing (no top-N candidate qualified, or a
      // cash/guardrail block). Re-forecast ETH at the base timeframe after the altcoin retry
      // delay ("try again later", default 1h) — it's not an ETH miss, so don't walk the ETH
      // shorter-timeframe retry ladder.
      this.retryStep = 0;
      nextTf = this.autoTimeframe;
      delayMs = altcoinRetryMs();
    } else {
      this.retryStep += 1;
      nextTf = this.retryStep === 1 ? "fourHourly" : "hourly";
      delayMs = this.retryMs;
    }

    this.nextTimeframe = nextTf;
    this.nextRunAt = Date.now() + delayMs;
    this.persistSchedule();
    this.loopTimer = setTimeout(() => {
      void this.runCycle(nextTf);
    }, delayMs);
    logger.info(
      {
        ran: timeframe,
        success,
        retryStep: this.retryStep,
        next: nextTf,
        nextInMin: Math.round(delayMs / 60_000),
      },
      "autonomous cycle scheduled",
    );
  }

  /** Schedule the next standalone qualifying-trade cycle (12h on success, 5min on retry). */
  private scheduleQualifyCycle(delayMs: number): void {
    if (!this.loopActive) return;
    this.clearQualifyTimer();
    this.qualifyNextAt = Date.now() + delayMs;
    this.persistSchedule();
    this.qualifyTimer = setTimeout(() => void this.runQualifyCycle(), delayMs);
  }

  private clearQualifyTimer(): void {
    if (this.qualifyTimer) {
      clearTimeout(this.qualifyTimer);
      this.qualifyTimer = undefined;
    }
  }

  /** Persist the loop + heartbeat next-fire times so a restart resumes the cadence
   *  instead of resetting it (best-effort; a disk error never breaks trading). */
  private persistSchedule(): void {
    try {
      mkdirSync(dirname(this.schedulePath), { recursive: true });
      const state: ScheduleState = {
        loopNextAt: this.nextRunAt,
        loopTimeframe: this.nextTimeframe,
        retryStep: this.retryStep,
        qualifyNextAt: this.qualifyNextAt,
        peakEquityUsd: this.peakEquityUsd,
      };
      writeFileSync(this.schedulePath, JSON.stringify(state, null, 2));
    } catch (e) {
      logger.warn(
        { err: e instanceof Error ? e.message : String(e) },
        "could not persist schedule",
      );
    }
  }

  /** Read the persisted schedule (empty if missing/corrupt). */
  private loadSchedule(): ScheduleState {
    try {
      if (!existsSync(this.schedulePath)) return {};
      const s = JSON.parse(readFileSync(this.schedulePath, "utf8"));
      return s && typeof s === "object" ? (s as ScheduleState) : {};
    } catch {
      return {};
    }
  }

  /**
   * Standalone Track-1 qualifying heartbeat — runs INDEPENDENTLY of the trading loop.
   * Every TRACK1_QUALIFY_INTERVAL_MS (12h) it does a guaranteed buy+sell round-trip so
   * the agent always logs a competition trade. On success it reschedules 12h out; on
   * failure it retries every TRACK1_QUALIFY_RETRY_MS (5min) until it lands. It never
   * collides with a trading-loop cycle: if one is running, it waits and re-checks.
   */
  private async runQualifyCycle(): Promise<void> {
    if (!this.loopActive) return;
    const intervalMs = num("TRACK1_QUALIFY_INTERVAL_MS", 43_200_000); // 12h
    const retryMs = num("TRACK1_QUALIFY_RETRY_MS", 300_000); // 5min
    if (
      (process.env.TRACK1_QUALIFY_ENABLED ?? "false").toLowerCase() !== "true"
    ) {
      this.scheduleQualifyCycle(intervalMs); // disabled now — re-check next interval
      return;
    }
    // Let the trading loop go first: if a cycle is mid-flight, wait and re-check.
    if (this.cycleInFlight || this.qualifyInFlight) {
      this.scheduleQualifyCycle(15_000);
      return;
    }
    const landed = await this.doQualifyingTrade();
    this.scheduleQualifyCycle(landed ? intervalMs : retryMs);
  }

  /** Reset the per-UTC-day trade/volume counters when the calendar day changes. */
  private rolloverDay(): void {
    const key = new Date().toISOString().slice(0, 10); // UTC YYYY-MM-DD
    if (key !== this.tradeDayKey) {
      this.tradeDayKey = key;
      this.tradesToday = 0;
      this.volumeTodayUsd = 0;
    }
  }

  /**
   * USD value of ETH the wallet holds BEYOND what the position ledger tracks — i.e. a stray
   * orphan (e.g. a Track-1 buy whose sell-back leg failed). Priced amount × live price, since
   * TWAK reports no valueUsd for non-stable tokens. Open forecast positions are subtracted so
   * this never counts a legitimately-held main-loop position as stray.
   */
  private async strayEthUsd(price: number): Promise<number> {
    if (!this.executor || price <= 0) return 0;
    const pf = await this.executor.getPortfolio();
    const walletEth = pf.holdings.find((h) => h.symbol === "ETH")?.amount ?? 0;
    const trackedEth = [...this.forecastTrades.values()]
      .filter((t) => t.asset === "ETH")
      .reduce((s, t) => s + t.boughtAmount, 0);
    return Math.max(0, walletEth - trackedEth) * price;
  }

  /**
   * Sell back stray ETH (see {@link strayEthUsd}) to USDT — the self-heal for a Track-1
   * round-trip whose sell-back failed and left the bought ETH stranded. Sells ONLY the
   * excess over tracked positions (so it can never dump an open main-loop position), sized
   * by amount × price with the close haircut so a live swap can't over-request, and is a
   * no-op below a dust floor (TRACK1_ETH_DUST_USD). Best-effort; returns what it sold.
   */
  private async flattenStrayEth(
    price: number,
    reason: string,
  ): Promise<{ sold: boolean; usd: number }> {
    if (!this.executor || price <= 0) return { sold: false, usd: 0 };
    let strayUsd = 0;
    try {
      strayUsd = await this.strayEthUsd(price);
    } catch (e) {
      logger.warn({ err: String(e) }, "flattenStrayEth: portfolio read failed");
      return { sold: false, usd: 0 };
    }
    if (strayUsd < num("TRACK1_ETH_DUST_USD", 0.5))
      return { sold: false, usd: 0 };
    const haircut = 1 - num("CLOSE_SELL_HAIRCUT_BPS", 50) / 10_000;
    const sellUsd = strayUsd * haircut;
    const r = await this.executor.swap({
      fromSymbol: "ETH",
      toSymbol: "USDT",
      amountUsd: sellUsd,
      maxSlippageBps: num("RISK_MAX_SLIPPAGE_BPS", 100),
    });
    if (!r.ok) {
      logger.error(
        { err: r.error, strayUsd: strayUsd.toFixed(2), reason },
        "flattenStrayEth: sell-back FAILED — ETH still held, will retry",
      );
      return { sold: false, usd: 0 };
    }
    logger.info(
      { soldUsd: sellUsd.toFixed(2), txHash: r.txHash, reason },
      "flattenStrayEth: sold stray ETH back to USDT",
    );
    return { sold: true, usd: sellUsd };
  }

  /**
   * One-shot startup flatten of stray ETH a prior failed Track-1 sell-back left in the
   * wallet (an orphan the ledger doesn't track). Live-only (the paper executor self-
   * reconciles); fire-and-forget so boot is never blocked on the network. Toggle with
   * TRACK1_FLATTEN_STRAY (default on).
   */
  private sweepStrayEthOnStartup(): void {
    if ((process.env.TRACK1_FLATTEN_STRAY ?? "true").toLowerCase() !== "true")
      return;
    if (this.mode !== "live" || !this.provider || !this.executor) return;
    void (async () => {
      try {
        const sig = await this.provider!.getTokenSignals(["ETH"]);
        const price = sig[0]?.priceUsd ?? 0;
        if (price > 0) await this.flattenStrayEth(price, "startup sweep");
      } catch (e) {
        logger.warn({ err: String(e) }, "startup stray-ETH sweep failed");
      }
    })();
  }

  /**
   * Guaranteed competition round-trip of TRACK1_QUALIFY_TRADE_USD ($1.5 by default —
   * independent of the loop's RISK_MAX_TRADE_USD) that registers a Track-1 trade with
   * ~zero net market exposure (cost = fees + slippage). It reads the open-position ledger
   * ONLY to tell its own ETH apart from a main-loop position (via {@link strayEthUsd}); it
   * never opens/closes a tracked position.
   *
   * Direction is chosen from what's available so the heartbeat still lands EVEN WHEN
   * the main loop has deployed the USDT cash into an open ETH position:
   *   - USDT cash ≥ size → buy ETH then sell exactly that ETH straight back (default).
   *   - else ETH (amount × live price) ≥ size → sell that much ETH then rebuy it.
   * The sell-back is sized off the ETH the wallet ACTUALLY received (NOT TWAK's valueUsd,
   * which is 0 for ETH) and capped, so it can never over-request and strand the buy. Any
   * stray ETH from a prior failed close is flattened first. Returns whether a clean
   * round-trip landed; the caller ({@link runQualifyCycle}) reschedules (interval on
   * success, short retry on failure — the pre-clean stops the retry from accumulating ETH).
   */
  private async doQualifyingTrade(): Promise<boolean> {
    if (!this.executor || !this.provider) return false;
    if (this.qualifyInFlight) return false; // never run two round-trips at once
    this.qualifyInFlight = true;
    const sizeUsd = this.qualifyTradeSizeUsd;
    const slippage = num("RISK_MAX_SLIPPAGE_BPS", 100);
    const haircut = 1 - num("CLOSE_SELL_HAIRCUT_BPS", 50) / 10_000; // default 0.5%
    const dustUsd = num("TRACK1_ETH_DUST_USD", 0.5);
    try {
      let price = 0;
      try {
        const sig = await this.provider.getTokenSignals(["ETH"]);
        price = sig[0]?.priceUsd ?? 0;
      } catch {
        /* fall through — handled below */
      }
      if (price <= 0) {
        logger.warn("Track 1 qualifying trade — no ETH price; will retry");
        return false;
      }
      this.executor.mark?.({ ETH: price });

      // Clear any ETH a PRIOR round-trip bought but failed to sell back, BEFORE opening a new
      // one, so orphans can never accumulate. If it still can't be cleared (e.g. TWAK down),
      // do NOT stack a fresh buy on top of it — defer and keep retrying the flatten.
      const cleanup = await this.flattenStrayEth(price, "pre-qualify cleanup");
      const strayLeft = await this.strayEthUsd(price);

      // A prior cycle's BUY may be waiting for its sell-back (qualifyBuyPending). The cleanup
      // above IS that sell-back — so the moment the stray clears, the buy+sell round-trip is
      // COMPLETE. Count it as the qualifying trade and sleep the full interval, instead of
      // opening a brand-new round-trip. THIS is the fix for the buy→fail-sell→buy churn: a
      // delayed sell-back that finally lands ENDS the round-trip, it doesn't start another.
      if (this.qualifyBuyPending) {
        if (strayLeft < dustUsd) {
          this.qualifyBuyPending = false;
          this.lastResult = {
            ok: true,
            traded: true,
            timeframe: "hourly",
            direction: "sideways",
            sizeUsd,
            reason:
              "Track 1 qualifying round-trip completed (delayed sell-back landed)",
          };
          logger.info(
            { soldUsd: cleanup.usd.toFixed(2) },
            "Track 1 qualifying round-trip COMPLETED on retry (earlier BUY + sell-back now) — sleeping full interval",
          );
          return true; // → TRACK1_QUALIFY_INTERVAL_MS sleep; do NOT re-buy
        }
        logger.warn(
          { strayUsd: strayLeft.toFixed(2) },
          "Track 1 — pending sell-back still failing; will retry the SAME ETH (no new buy)",
        );
        return false;
      }

      // No buy pending: any stray here is an untracked orphan — clear it before opening a buy.
      if (strayLeft >= dustUsd) {
        logger.warn(
          "Track 1 — stray ETH not yet flattened; deferring new round-trip until clear",
        );
        return false;
      }

      const pf = await this.executor.getPortfolio();
      // Price ETH ourselves (amount × price): TWAK reports NO valueUsd for non-stable tokens,
      // so relying on valueUsd (always 0 for ETH) silently breaks the size check and the
      // sell-back sizing — which is exactly what stranded the bought ETH.
      const ethUsd =
        (pf.holdings.find((h) => h.symbol === "ETH")?.amount ?? 0) * price;

      if (pf.cashUsd >= sizeUsd) {
        // BUY ETH (this leg IS the qualifying trade — it counts), then sell exactly it back.
        const open = await this.executor.swap({
          fromSymbol: "USDT",
          toSymbol: "ETH",
          amountUsd: sizeUsd,
          maxSlippageBps: slippage,
        });
        if (!open.ok) {
          logger.warn(
            { err: open.error },
            "Track 1 buy leg failed; will retry",
          );
          return false;
        }
        // Sell back exactly the ETH just received (= the new stray over tracked positions),
        // capped at the real on-chain balance + haircut so the live swap can't over-request.
        const flat = await this.flattenStrayEth(
          price,
          "qualify round-trip close",
        );
        // Sell-back failed → park the ETH as a PENDING round-trip so the next cycle's flatten
        // completes it (→ interval sleep) instead of stacking a fresh buy. Succeeded → clear.
        this.qualifyBuyPending = !flat.sold;
        this.lastResult = {
          ok: true,
          traded: true,
          timeframe: "hourly",
          direction: "sideways",
          sizeUsd,
          reason: flat.sold
            ? "Track 1 qualifying round-trip (guaranteed daily trade)"
            : "Track 1 qualifying BUY landed; sell-back pending — will retry",
          txHash: open.txHash,
        };
        logger.info(
          {
            sizeUsd,
            openTx: open.txHash,
            soldBack: flat.sold,
            soldUsd: flat.usd.toFixed(2),
          },
          flat.sold
            ? "Track 1 qualifying round-trip executed (buy + sell-back)"
            : "Track 1 qualifying BUY executed; SELL-BACK FAILED — will flatten on retry",
        );
        // Success only when the round-trip is flat. If the sell-back failed, retry soon —
        // the pre-clean above flattens the stray ETH first, so the retry never stacks a buy.
        return flat.sold;
      }

      if (ethUsd >= sizeUsd) {
        // Cash-poor but holding ETH: SELL first (the qualifying trade), then rebuy to restore.
        const sellUsd = Math.min(sizeUsd, ethUsd) * haircut;
        const open = await this.executor.swap({
          fromSymbol: "ETH",
          toSymbol: "USDT",
          amountUsd: sellUsd,
          maxSlippageBps: slippage,
        });
        if (!open.ok) {
          logger.warn(
            { err: open.error },
            "Track 1 sell leg failed; will retry",
          );
          return false;
        }
        const rebuy = await this.executor.swap({
          fromSymbol: "USDT",
          toSymbol: "ETH",
          amountUsd: sellUsd,
          maxSlippageBps: slippage,
        });
        this.lastResult = {
          ok: true,
          traded: true,
          timeframe: "hourly",
          direction: "sideways",
          sizeUsd: sellUsd,
          reason: rebuy.ok
            ? "Track 1 qualifying round-trip (sell then rebuy)"
            : "Track 1 qualifying SELL landed; rebuy FAILED — ETH not restored",
          txHash: open.txHash,
        };
        // The SELL is the qualifying trade and it already succeeded, so the heartbeat is
        // satisfied EITHER WAY — return true so a retry can't re-sell and compound the
        // imbalance. But a failed rebuy leaves the wallet short ETH / long USDT, which the
        // stray-ETH sweep can't fix (it only sheds EXCESS ETH), so surface it loudly.
        if (rebuy.ok) {
          logger.info(
            { sizeUsd: sellUsd, sellTx: open.txHash, rebuyTx: rebuy.txHash },
            "Track 1 qualifying round-trip executed (sell + rebuy)",
          );
        } else {
          logger.error(
            { sizeUsd: sellUsd, sellTx: open.txHash, rebuyErr: rebuy.error },
            "Track 1 qualifying SELL executed; REBUY FAILED — wallet left short ETH, needs reconcile",
          );
        }
        return true;
      }

      logger.warn(
        { cashUsd: pf.cashUsd, ethUsd, sizeUsd },
        "Track 1 qualifying trade — neither USDT cash nor ETH ≥ size; will retry",
      );
      return false;
    } catch (e) {
      logger.error(
        { err: String(e) },
        "Track 1 qualifying trade errored; will retry",
      );
      return false;
    } finally {
      this.qualifyInFlight = false;
    }
  }

  async getStatus(): Promise<TradingStatus> {
    // Refresh mark prices for held assets so paper-mode equity is valued at the
    // CURRENT price. The in-memory price cache starts empty after a restart, so
    // without this a held position would show $0 until the next trade cycle marks
    // it. Paper-only: the live (TWAK) executor prices on-chain, so a fetch+mark
    // there would just waste a CMC call.
    if (this.mode === "paper" && this.provider && this.executor?.mark) {
      const assets = [
        ...new Set([...this.forecastTrades.values()].map((t) => t.asset)),
      ];
      if (assets.length) {
        try {
          const sigs = await this.provider.getTokenSignals(assets);
          const px: Record<string, number> = {};
          for (const s of sigs)
            if (s?.symbol && s.priceUsd > 0) px[s.symbol] = s.priceUsd;
          if (Object.keys(px).length) this.executor.mark(px);
        } catch (e) {
          logger.warn({ err: String(e) }, "getStatus: mark refresh failed");
        }
      }
    }
    let portfolio: Portfolio | undefined;
    try {
      portfolio = this.executor
        ? await this.executor.getPortfolio()
        : undefined;
    } catch (e) {
      // In live mode a TWAK balance error must not break the whole status report.
      logger.warn({ err: String(e) }, "getStatus: portfolio fetch failed");
    }
    // TWAK reports no USD value for non-stable tokens (valueUsd = 0), so a live ETH holding
    // shows "$0.00" and equity is understated. Price the unvalued holdings ourselves
    // (amount × live price) so status reflects what's really in the wallet.
    if (portfolio && this.mode === "live" && this.provider) {
      const unpriced = portfolio.holdings.filter(
        (h) => h.amount > 0 && (!h.valueUsd || h.valueUsd <= 0),
      );
      if (unpriced.length) {
        try {
          const sigs = await this.provider.getTokenSignals(
            unpriced.map((h) => h.symbol),
          );
          const px: Record<string, number> = {};
          for (const s of sigs)
            if (s?.symbol && s.priceUsd > 0) px[s.symbol] = s.priceUsd;
          for (const h of portfolio.holdings)
            if ((!h.valueUsd || h.valueUsd <= 0) && px[h.symbol])
              h.valueUsd = h.amount * px[h.symbol];
          portfolio.totalValueUsd =
            portfolio.cashUsd +
            portfolio.holdings.reduce((s, h) => s + h.valueUsd, 0);
        } catch (e) {
          logger.warn(
            { err: String(e) },
            "getStatus: live holding valuation failed",
          );
        }
      }
    }
    return {
      running: this.running,
      symbols: this.symbols,
      intervalMs: this.intervalMs,
      mode: this.mode,
      tradeSizeUsd: this.tradeSizeUsd,
      takeProfitPct: this.takeProfitPct,
      takeProfitEnabled: this.takeProfitEnabled,
      withdrawTimelineMainMs: this.withdrawTimelineMainMs,
      withdrawTimelineAltMs: this.withdrawTimelineAltMs,
      baseTimeframe: this.autoTimeframe,
      retryStep: this.retryStep,
      nextTimeframe: this.nextTimeframe,
      nextRunAt: this.nextRunAt,
      portfolio,
      openTrades: [...this.forecastTrades.values()],
      lastResult: this.lastResult,
      track1: {
        enabled:
          (process.env.TRACK1_QUALIFY_ENABLED ?? "false").toLowerCase() ===
          "true",
        tradeSizeUsd: this.qualifyTradeSizeUsd,
        intervalMs: num("TRACK1_QUALIFY_INTERVAL_MS", 43_200_000),
        // The heartbeat only runs while the main loop is active; surface its next
        // fire only then so a stale persisted time isn't shown after a stop.
        nextRunAt: this.loopActive ? this.qualifyNextAt : undefined,
        inFlight: this.qualifyInFlight,
      },
    };
  }

  /**
   * Live snapshot of every open forecast position with mark-to-market PnL. Marks each
   * position's asset at the current CMC price; if a price can't be fetched it falls
   * back to the entry price (flat PnL for that leg) rather than failing. Pure read —
   * never trades, never mutates state.
   */
  async getPositions(): Promise<PositionsReport> {
    const trades = [...this.forecastTrades.values()];
    const prices: Record<string, number> = {};
    let anyPriced = false;
    const assets = [...new Set(trades.map((t) => t.asset))];
    if (this.provider && assets.length) {
      try {
        const sigs = await this.provider.getTokenSignals(assets);
        for (const s of sigs)
          if (s?.symbol && s.priceUsd > 0) prices[s.symbol] = s.priceUsd;
      } catch (e) {
        logger.warn({ err: String(e) }, "getPositions: price fetch failed");
      }
    }
    const positions: OpenPositionPnL[] = trades.map((t) => {
      const live = prices[t.asset];
      const priced = typeof live === "number" && live > 0;
      if (priced) anyPriced = true;
      const currentPrice = priced ? live : t.entryPrice;
      const currentValueUsd = t.boughtAmount * currentPrice;
      const pnlUsd = (currentPrice - t.entryPrice) * t.boughtAmount;
      const pnlPct =
        t.entryPrice > 0 ? (currentPrice / t.entryPrice - 1) * 100 : 0;
      return {
        id: t.id,
        asset: t.asset,
        timeframe: t.timeframe,
        sizeUsd: t.sizeUsd,
        entryPrice: t.entryPrice,
        currentPrice,
        boughtAmount: t.boughtAmount,
        currentValueUsd,
        pnlUsd,
        pnlPct,
        priced,
        openedAt: t.openedAt,
        closeAt: t.closeAt,
      };
    });
    const totalCostUsd = positions.reduce(
      (s, p) => s + p.boughtAmount * p.entryPrice,
      0,
    );
    const totalValueUsd = positions.reduce((s, p) => s + p.currentValueUsd, 0);
    const totalPnlUsd = totalValueUsd - totalCostUsd;
    const totalPnlPct =
      totalCostUsd > 0 ? (totalPnlUsd / totalCostUsd) * 100 : 0;
    return {
      positions,
      totalCostUsd,
      totalValueUsd,
      totalPnlUsd,
      totalPnlPct,
      anyPriced,
    };
  }

  /**
   * Trade diagnostics — a readiness/health check across every subsystem.
   * Runs live probes (CMC price, a real forecast, executor portfolio) so it
   * surfaces issues like a missing key or the TWAK swap 403 immediately.
   */
  async runDiagnostics(): Promise<DiagCheck[]> {
    const checks: DiagCheck[] = [];
    const isSet = (k: string): boolean => !!process.env[k]?.trim();
    const errMsg = (e: unknown): string =>
      e instanceof Error ? e.message : String(e);

    // --- Configuration (no network) ---
    checks.push({
      name: "OpenRouter API key",
      status: isSet("OPENROUTER_API_KEY") ? "pass" : "fail",
      detail: isSet("OPENROUTER_API_KEY")
        ? "configured"
        : "OPENROUTER_API_KEY missing",
    });
    checks.push({
      name: "CoinMarketCap API key",
      status: isSet("COINMARKETCAP_API_KEY") ? "pass" : "fail",
      detail: isSet("COINMARKETCAP_API_KEY")
        ? "configured"
        : "COINMARKETCAP_API_KEY missing",
    });
    checks.push({
      name: "Mode",
      status: "info",
      detail:
        this.mode === "live"
          ? "live (real on-chain swaps via TWAK)"
          : "paper (simulated)",
    });
    checks.push({
      name: "Risk limits",
      status: "info",
      detail: `$${this.tradeSizeUsd}/trade · conviction ≥ ${num("RISK_MIN_CONVICTION", 60)}% · ${num("RISK_MAX_TRADES_PER_DAY", 2)} trades/day · slippage ≤ ${num("RISK_MAX_SLIPPAGE_BPS", 100) / 100}% · take-profit ${this.takeProfitEnabled ? `+${this.takeProfitPct}%` : "off"}`,
    });
    if (this.mode === "live") {
      const twak = isSet("TWAK_ACCESS_ID") && isSet("TWAK_HMAC_SECRET");
      checks.push({
        name: "TWAK credentials",
        status: twak ? "pass" : "fail",
        detail: twak
          ? "configured"
          : "TWAK_ACCESS_ID / TWAK_HMAC_SECRET missing",
      });
      checks.push({
        name: "Agent wallet",
        status: isSet("AGENT_WALLET_ADDRESS") ? "pass" : "warn",
        detail: isSet("AGENT_WALLET_ADDRESS")
          ? (process.env.AGENT_WALLET_ADDRESS as string)
          : "AGENT_WALLET_ADDRESS not set",
      });
    }

    // --- Service init ---
    if (!this.provider || !this.executor) {
      checks.push({
        name: "Trading service",
        status: "fail",
        detail: "provider/executor not initialized (check API keys)",
      });
      return checks;
    }

    // --- Market data (CMC REST) ---
    try {
      const sig = await this.provider.getTokenSignals(["ETH"]);
      const price = sig[0]?.priceUsd ?? 0;
      checks.push({
        name: "Market data (CMC)",
        status: price > 0 ? "pass" : "fail",
        detail:
          price > 0 ? `ETH = $${price.toLocaleString()}` : "no price returned",
      });
    } catch (e) {
      checks.push({
        name: "Market data (CMC)",
        status: "fail",
        detail: errMsg(e),
      });
    }

    // --- Forecast engine (options data + LLM) ---
    try {
      const f = await generateForecast("ETH", "hourly");
      checks.push({
        name: "Forecast engine",
        status: "pass",
        detail: `ETH 1H → ${f.prediction.direction.toUpperCase()} ${(f.prediction.confidence * 100).toFixed(0)}% (sources: ${f.sourcesUsed?.join(", ") || "n/a"})`,
      });
    } catch (e) {
      checks.push({
        name: "Forecast engine",
        status: "fail",
        detail: errMsg(e),
      });
    }

    // --- Execution (paper portfolio, or live TWAK — surfaces the swap/balance 403) ---
    const execName =
      this.mode === "live" ? "Execution (TWAK)" : "Execution (paper)";
    try {
      const pf = await this.executor.getPortfolio();
      checks.push({
        name: execName,
        status: "pass",
        detail: `cash $${pf.cashUsd.toFixed(2)} · equity $${pf.totalValueUsd.toFixed(2)} · ${pf.holdings.length} holding(s)`,
      });
    } catch (e) {
      checks.push({ name: execName, status: "fail", detail: errMsg(e) });
    }

    // --- x402 enrichment (CMC pay-per-request signal; read-only quote of the 1st endpoint, no payment) ---
    const x402Urls = (process.env.X402_DATA_URL ?? "")
      .split(",")
      .map((u) => u.trim())
      .filter(Boolean);
    const x402On = (process.env.X402_ENRICH ?? "").toLowerCase() === "true";
    if (x402Urls.length === 0) {
      checks.push({
        name: "x402 enrichment",
        status: "info",
        detail: "not configured (X402_DATA_URL empty)",
      });
    } else {
      const n = `${x402Urls.length} endpoint${x402Urls.length === 1 ? "" : "s"}`;
      try {
        const q = await quoteX402(x402Urls[0], { timeoutMs: 20_000 });
        const reachable = q.ok || q.priceAtomic !== undefined;
        const price =
          q.priceAtomic !== undefined ? ` · ${q.priceAtomic} atomic/call` : "";
        if (!reachable) {
          checks.push({
            name: "x402 enrichment",
            status: x402On ? "fail" : "warn",
            detail: `1st endpoint not payable: ${q.error ?? "no payment challenge"}`,
          });
        } else if (x402On) {
          checks.push({
            name: "x402 enrichment",
            status: "pass",
            detail: `ON · ${n} · CMC reachable${price}`,
          });
        } else {
          checks.push({
            name: "x402 enrichment",
            status: "info",
            detail: `${n} configured, OFF (set X402_ENRICH=true once USDC on Base is funded)${price}`,
          });
        }
      } catch (e) {
        checks.push({
          name: "x402 enrichment",
          status: x402On ? "fail" : "warn",
          detail: `quote errored: ${errMsg(e)}`,
        });
      }
    }

    // --- State ---
    const withdrawNote =
      this.withdrawTimelineMainMs || this.withdrawTimelineAltMs
        ? ` · custom withdraw timeline ${[
            this.withdrawTimelineMainMs &&
              `main ${fmtDur(this.withdrawTimelineMainMs)}`,
            this.withdrawTimelineAltMs &&
              `alt ${fmtDur(this.withdrawTimelineAltMs)}`,
          ]
            .filter(Boolean)
            .join(" / ")}`
        : "";
    checks.push({
      name: "Autonomous loop",
      status: "info",
      detail: this.running
        ? `running · ${this.autoTimeframe} every ${Math.round(this.intervalMs / 3_600_000)}h${this.nextTimeframe ? ` · next ${this.nextTimeframe}` : ""}${withdrawNote}`
        : `stopped${withdrawNote}`,
    });
    checks.push({
      name: "Open positions",
      status: "info",
      detail: `${this.forecastTrades.size} open`,
    });

    return checks;
  }
}
