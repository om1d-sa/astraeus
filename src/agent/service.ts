import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Service, type IAgentRuntime, logger } from "@elizaos/core";
import { CmcDataProvider } from "../data/cmc";
import { PaperExecutor } from "../exec/paper";
import { TwakExecutor } from "../exec/twak";
import type { Executor, Portfolio } from "../exec/types";
import {
  generateForecast,
  type ForecastTimeframe,
  type PriceForecast,
} from "../skills/options-forecast";
import { gatherForecastEnrichment } from "../skills/options-forecast/enrich";
import { parseTimeframe } from "../actions/forecast";
import { quoteX402 } from "../exec/x402";
import { checkGuardrails, shouldTakeProfit } from "../config/risk";

const num = (key: string, fallback: number): number => {
  const v = process.env[key];
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
};

/** How long a forecast-driven position is held before auto-close (= the forecast horizon). */
const TIMEFRAME_MS: Record<ForecastTimeframe, number> = {
  hourly: 3_600_000, // 1h
  fourHourly: 14_400_000, // 4h
  daily: 86_400_000, // 24h
  weekly: 604_800_000, // 7d
};

export interface OpenForecastTrade {
  id: string;
  asset: string;
  timeframe: ForecastTimeframe;
  sizeUsd: number;
  entryPrice: number;
  boughtAmount: number;
  openedAt: number;
  closeAt: number;
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

export interface TradingStatus {
  running: boolean;
  symbols: string[];
  intervalMs: number;
  mode: "paper" | "live";
  tradeSizeUsd: number;
  /** Take-profit: close a position early once up this % (0/off when disabled). */
  takeProfitPct: number;
  takeProfitEnabled: boolean;
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
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly forecastTrades = new Map<string, OpenForecastTrade>();
  private lastResult?: ForecastTradeResult;
  /** Where open positions are persisted so they survive an agent restart. */
  private readonly statePath: string;

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
    try {
      this.provider = new CmcDataProvider();
      this.executor =
        this.mode === "live"
          ? new TwakExecutor({
              chain: "bsc",
              stableSymbol: "USDT",
              defaultSlippagePct: num("RISK_MAX_SLIPPAGE_BPS", 100) / 100,
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
    if (/\b(trade|auto|on|true)\b/i.test(process.env.AUTONOMOUS_MODE ?? "")) {
      const r = service.startLoop();
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
    const asset = "ETH";
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
    this.executor.mark?.({ ETH: price });
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
      tokenSymbol: "ETH",
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
      toSymbol: "ETH",
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
    const closeAt = Date.now() + TIMEFRAME_MS[timeframe];
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
      }, TIMEFRAME_MS[timeframe]),
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

    let price = t.entryPrice;
    try {
      const sig = await this.provider.getTokenSignals([t.asset]);
      price = sig[0]?.priceUsd || t.entryPrice;
    } catch {
      /* keep entry price as fallback */
    }
    this.executor.mark?.({ [t.asset]: price });
    const swap = await this.executor.swap({
      fromSymbol: t.asset,
      toSymbol: "USDT",
      amountUsd: t.boughtAmount * price,
      maxSlippageBps: num("RISK_MAX_SLIPPAGE_BPS", 100),
    });
    const pnlUsd = (price - t.entryPrice) * t.boughtAmount;
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
        this.timers.set(
          t.id,
          setTimeout(() => {
            this.closeForecastTrade(t.id).catch((e) =>
              logger.error({ err: String(e) }, "forecast trade close failed"),
            );
          }, remaining),
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
  startLoop(): { ok: boolean; reason?: string } {
    if (!this.executor)
      return { ok: false, reason: "not initialized (COINMARKETCAP_API_KEY?)" };
    if (this.loopActive) return { ok: false, reason: "already running" };
    this.loopActive = true;
    this.retryStep = 0;
    void this.runCycle(this.autoTimeframe);
    // Start the standalone Track-1 qualifying heartbeat; first one is one interval out.
    this.scheduleQualifyCycle(num("TRACK1_QUALIFY_INTERVAL_MS", 43_200_000));
    // Start the take-profit monitor (no-op unless RISK_TAKE_PROFIT_ENABLED=true).
    this.scheduleTakeProfitCheck();
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
   * Take-profit monitor — the OPPOSITE of the drawdown halt. Marks the current ETH
   * price and closes EARLY any open position whose unrealized gain has reached
   * takeProfitPct, locking in the profit instead of waiting out the timeframe.
   * Best-effort: never throws, never blocks the loop.
   */
  async checkTakeProfit(): Promise<number> {
    if (!this.takeProfitEnabled || !this.provider || !this.executor) return 0;
    if (this.forecastTrades.size === 0) return 0;
    let price = 0;
    try {
      const sig = await this.provider.getTokenSignals(["ETH"]);
      price = sig[0]?.priceUsd ?? 0;
    } catch {
      return 0; // no price → don't act
    }
    if (price <= 0) return 0;
    this.executor.mark?.({ ETH: price });
    let closed = 0;
    for (const [id, t] of [...this.forecastTrades]) {
      if (shouldTakeProfit(t.entryPrice, price, this.takeProfitPct)) {
        const gainPct = ((price - t.entryPrice) / t.entryPrice) * 100;
        logger.info(
          { id, entry: t.entryPrice, price, gainPct: gainPct.toFixed(1) },
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
    this.cycleInFlight = true; // the qualifying heartbeat defers while this runs
    try {
      const r = await this.forecastAndTrade(timeframe, this.autoCmc);
      success = r.traded === true;
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
    } else {
      this.retryStep += 1;
      nextTf = this.retryStep === 1 ? "fourHourly" : "hourly";
      delayMs = this.retryMs;
    }

    this.nextTimeframe = nextTf;
    this.nextRunAt = Date.now() + delayMs;
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
    this.qualifyTimer = setTimeout(() => void this.runQualifyCycle(), delayMs);
  }

  private clearQualifyTimer(): void {
    if (this.qualifyTimer) {
      clearTimeout(this.qualifyTimer);
      this.qualifyTimer = undefined;
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
   * Guaranteed competition round-trip of TRACK1_QUALIFY_TRADE_USD ($1.5 by default —
   * independent of the loop's RISK_MAX_TRADE_USD) that registers a Track-1 trade with
   * ~zero net market exposure (cost = fees + slippage). Fully self-contained and
   * INDEPENDENT of the trading loop: it never reads/writes the loop's open-position
   * map, so a successful main-loop trade never cancels it.
   *
   * Direction is chosen from what's available so the heartbeat still lands EVEN WHEN
   * the main loop has deployed the USDT cash into an open ETH position:
   *   - USDT cash ≥ size → buy ETH then sell it straight back (default).
   *   - else ETH held ≥ size → sell that much ETH then immediately rebuy it.
   * Either way the portfolio returns to its starting allocation. Returns whether it
   * landed; the caller ({@link runQualifyCycle}) reschedules (interval on success,
   * retry on failure).
   */
  private async doQualifyingTrade(): Promise<boolean> {
    if (!this.executor || !this.provider) return false;
    if (this.qualifyInFlight) return false; // never run two round-trips at once
    this.qualifyInFlight = true;
    const sizeUsd = this.qualifyTradeSizeUsd;
    const slippage = num("RISK_MAX_SLIPPAGE_BPS", 100);
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
      const pf = await this.executor.getPortfolio();
      const ethUsd = pf.holdings.find((h) => h.symbol === "ETH")?.valueUsd ?? 0;

      // Pick the round-trip direction from available funds. Prefer spending USDT cash;
      // fall back to the ETH the main loop is holding so the safety trade still lands.
      const legs =
        pf.cashUsd >= sizeUsd
          ? ([
              { fromSymbol: "USDT", toSymbol: "ETH" },
              { fromSymbol: "ETH", toSymbol: "USDT" },
            ] as const)
          : ethUsd >= sizeUsd
            ? ([
                { fromSymbol: "ETH", toSymbol: "USDT" },
                { fromSymbol: "USDT", toSymbol: "ETH" },
              ] as const)
            : undefined;
      if (!legs) {
        logger.warn(
          { cashUsd: pf.cashUsd, ethUsd, sizeUsd },
          "Track 1 qualifying trade — neither USDT cash nor ETH ≥ size; will retry",
        );
        return false;
      }

      const open = await this.executor.swap({
        fromSymbol: legs[0].fromSymbol,
        toSymbol: legs[0].toSymbol,
        amountUsd: sizeUsd,
        maxSlippageBps: slippage,
      });
      if (!open.ok) {
        logger.warn(
          { err: open.error, leg: legs[0] },
          "Track 1 qualifying first leg failed; will retry",
        );
        return false;
      }
      // Immediately reverse it to return to the starting allocation (minimize exposure).
      const close = await this.executor.swap({
        fromSymbol: legs[1].fromSymbol,
        toSymbol: legs[1].toSymbol,
        amountUsd: sizeUsd,
        maxSlippageBps: slippage,
      });
      this.lastResult = {
        ok: true,
        traded: true,
        timeframe: "hourly",
        direction: "sideways",
        sizeUsd,
        reason: "Track 1 qualifying round-trip (guaranteed daily trade)",
        txHash: open.txHash,
      };
      logger.info(
        {
          sizeUsd,
          startedFrom: legs[0].fromSymbol,
          openTx: open.txHash,
          closeTx: close.txHash,
          closeOk: close.ok,
        },
        "Track 1 qualifying round-trip executed (competition daily-trade safety)",
      );
      return true;
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
    return {
      running: this.running,
      symbols: this.symbols,
      intervalMs: this.intervalMs,
      mode: this.mode,
      tradeSizeUsd: this.tradeSizeUsd,
      takeProfitPct: this.takeProfitPct,
      takeProfitEnabled: this.takeProfitEnabled,
      baseTimeframe: this.autoTimeframe,
      retryStep: this.retryStep,
      nextTimeframe: this.nextTimeframe,
      nextRunAt: this.nextRunAt,
      portfolio,
      openTrades: [...this.forecastTrades.values()],
      lastResult: this.lastResult,
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
    const totalPnlPct = totalCostUsd > 0 ? (totalPnlUsd / totalCostUsd) * 100 : 0;
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
    checks.push({
      name: "Autonomous loop",
      status: "info",
      detail: this.running
        ? `running · ${this.autoTimeframe} every ${Math.round(this.intervalMs / 3_600_000)}h${this.nextTimeframe ? ` · next ${this.nextTimeframe}` : ""}`
        : "stopped",
    });
    checks.push({
      name: "Open positions",
      status: "info",
      detail: `${this.forecastTrades.size} open`,
    });

    return checks;
  }
}
