/**
 * Autonomous trading loop — the Track 1 agent shell.
 *
 * One tick = the full cycle: pull market data → decide per token → risk
 * guardrails → size → execute → record. It is executor-agnostic (paper now,
 * Trust Wallet Agent Kit later) and data-agnostic (CMC REST/MCP, or recorded
 * data). Halts trading if the drawdown cap is breached, and honors the daily
 * trade/volume caps.
 */

import { DEFAULT_PARAMS, evaluate, sizePosition } from '../strategy';
import type { StrategyParams } from '../strategy/types';
import { checkGuardrails, getRiskConfig, type RiskConfig } from '../config/risk';
import { isEligibleToken } from '../config/tokens';
import type { MarketDataProvider } from '../data/types';
import type { Executor } from '../exec/types';

export interface TraderOptions {
  symbols: string[];
  stableSymbol?: string;
  params?: StrategyParams;
  risk?: RiskConfig;
}

export interface TickReport {
  tick: number;
  equityUsd: number;
  drawdownPct: number;
  halted: boolean;
  /** Human-readable actions taken (or skipped) this tick. */
  actions: string[];
}

/** An executor that can be fed mark prices (the paper executor). */
type Markable = { mark?: (prices: Record<string, number>) => void };

export class AutonomousTrader {
  private peakEquity = 0;
  private tradesToday = 0;
  private volumeTodayUsd = 0;
  private dayKey = '';
  private halted = false;
  private tickCount = 0;
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly provider: MarketDataProvider,
    private readonly executor: Executor,
    private readonly opts: TraderOptions,
  ) {}

  get running(): boolean {
    return this.timer !== undefined;
  }

  /** Run one decision→execute cycle. */
  async tick(): Promise<TickReport> {
    this.tickCount += 1;
    const actions: string[] = [];
    const stableSymbol = this.opts.stableSymbol ?? 'USDT';
    const params = this.opts.params ?? DEFAULT_PARAMS;
    const risk = this.opts.risk ?? getRiskConfig();

    // Reset per-UTC-day counters.
    const dk = new Date().toISOString().slice(0, 10);
    if (dk !== this.dayKey) {
      this.dayKey = dk;
      this.tradesToday = 0;
      this.volumeTodayUsd = 0;
    }

    const [market, signals] = await Promise.all([
      this.provider.getMarketContext(),
      this.provider.getTokenSignals(this.opts.symbols),
    ]);

    // Feed prices to the executor (paper executor needs them to value/fill).
    const priceMap: Record<string, number> = {};
    for (const s of signals) priceMap[s.symbol] = s.priceUsd;
    (this.executor as Markable).mark?.(priceMap);

    const portfolio = await this.executor.getPortfolio();
    const equity = portfolio.totalValueUsd;
    this.peakEquity = Math.max(this.peakEquity, equity);
    const drawdownPct = this.peakEquity > 0 ? ((this.peakEquity - equity) / this.peakEquity) * 100 : 0;

    // Drawdown DQ-gate: stop trading entirely if breached.
    if (drawdownPct >= risk.maxDrawdownPct) this.halted = true;
    if (this.halted) {
      actions.push(`HALTED — drawdown ${drawdownPct.toFixed(1)}% ≥ cap ${risk.maxDrawdownPct}%`);
      return { tick: this.tickCount, equityUsd: equity, drawdownPct, halted: true, actions };
    }

    const held = new Map(portfolio.holdings.map((h) => [h.symbol, h]));

    for (const sig of signals) {
      const sym = sig.symbol;
      if (sym === stableSymbol) continue;
      const decision = evaluate(sig, market, params);
      const holding = held.get(sym);

      if (holding && decision.direction === 'sell') {
        const r = await this.executor.swap({
          fromSymbol: sym,
          toSymbol: stableSymbol,
          amountUsd: holding.valueUsd,
          maxSlippageBps: risk.maxSlippageBps,
        });
        if (r.ok) {
          this.tradesToday += 1;
          this.volumeTodayUsd += holding.valueUsd;
          actions.push(`SELL ${sym} ~$${holding.valueUsd.toFixed(2)} (${r.txHash})`);
        } else {
          actions.push(`SELL ${sym} failed: ${r.error}`);
        }
        continue;
      }

      if (!holding && decision.direction === 'buy') {
        const sizeUsd = sizePosition(decision, portfolio.cashUsd, risk);
        if (sizeUsd <= 0) continue;
        const guard = checkGuardrails(
          {
            conviction: decision.conviction,
            tradeUsd: sizeUsd,
            currentDrawdownPct: drawdownPct,
            tradesToday: this.tradesToday,
            volumeTodayUsd: this.volumeTodayUsd,
            tokenSymbol: sym,
            isTokenEligible: isEligibleToken(sym),
          },
          risk,
        );
        if (!guard.allowed) {
          actions.push(`skip ${sym}: ${guard.reason}`);
          continue;
        }
        const r = await this.executor.swap({
          fromSymbol: stableSymbol,
          toSymbol: sym,
          amountUsd: sizeUsd,
          maxSlippageBps: risk.maxSlippageBps,
        });
        if (r.ok) {
          this.tradesToday += 1;
          this.volumeTodayUsd += sizeUsd;
          actions.push(`BUY ${sym} $${sizeUsd.toFixed(2)} @ ${decision.conviction}% (${r.txHash})`);
        } else {
          actions.push(`BUY ${sym} failed: ${r.error}`);
        }
      }
    }

    return { tick: this.tickCount, equityUsd: equity, drawdownPct, halted: false, actions };
  }

  /** Start the loop on an interval. Each tick is independent and self-throttling. */
  start(intervalMs: number): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((e) => console.error('[AutonomousTrader] tick error:', e));
    }, intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
