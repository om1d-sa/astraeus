/**
 * Backtest engine — long-only spot simulation of the Astraeus strategy.
 *
 * For each bar it asks the strategy for a decision per token, applies the SAME
 * risk guardrails and position sizing the live agent uses, simulates fills with
 * fee + slippage, and marks the portfolio to market. The output metrics
 * (total return, max drawdown, win rate) mirror how Track 1 is judged, so a good
 * backtest here is direct evidence for the Track 2 strategy spec.
 */

import { DEFAULT_PARAMS, evaluate, sizePosition } from '../strategy';
import type { StrategyParams } from '../strategy/types';
import { checkGuardrails, getRiskConfig, type RiskConfig } from '../config/risk';
import type { BacktestConfig, BacktestResult, ClosedTrade, Series } from './types';

export const DEFAULT_BACKTEST_CONFIG: BacktestConfig = {
  startingCashUsd: 100,
  feeBps: 10, // 0.10% taker
  slippageBps: 20, // 0.20% assumed slippage
  maxPositions: 3,
};

interface Position {
  symbol: string;
  amount: number;
  entryPrice: number;
  entryT: number;
  costUsd: number;
}

export function runBacktest(
  series: Series,
  params: StrategyParams = DEFAULT_PARAMS,
  risk: RiskConfig = getRiskConfig(),
  cfg: BacktestConfig = DEFAULT_BACKTEST_CONFIG,
): BacktestResult {
  let cash = cfg.startingCashUsd;
  const positions = new Map<string, Position>();
  const closedTrades: ClosedTrade[] = [];
  const equityCurve: Array<{ t: number; equity: number }> = [];
  const txCostRate = (cfg.feeBps + cfg.slippageBps) / 10_000;

  let peakEquity = cash;
  let maxDrawdownPct = 0;
  let tradesToday = 0;
  let volumeTodayUsd = 0;
  let dayKey = '';

  const priceOf = (bar: Series[number], sym: string): number => bar.tokens[sym]?.priceUsd ?? 0;
  const equityAt = (bar: Series[number]): number =>
    cash + [...positions.values()].reduce((s, p) => s + p.amount * priceOf(bar, p.symbol), 0);

  for (const bar of series) {
    const dk = new Date(bar.t).toISOString().slice(0, 10);
    if (dk !== dayKey) {
      dayKey = dk;
      tradesToday = 0;
      volumeTodayUsd = 0;
    }

    // Mark-to-market and update drawdown using current positions.
    const equity = equityAt(bar);
    peakEquity = Math.max(peakEquity, equity);
    const ddPct = peakEquity > 0 ? ((peakEquity - equity) / peakEquity) * 100 : 0;
    maxDrawdownPct = Math.max(maxDrawdownPct, ddPct);

    for (const sym of Object.keys(bar.tokens)) {
      const sig = bar.tokens[sym];
      const price = sig.priceUsd;
      if (!price) continue;

      const decision = evaluate(sig, bar.market, params);
      const holding = positions.get(sym);

      // Exit on a sell signal.
      if (holding && decision.direction === 'sell') {
        const proceeds = holding.amount * price * (1 - txCostRate);
        cash += proceeds;
        const pnlUsd = proceeds - holding.costUsd;
        closedTrades.push({
          symbol: sym,
          entryT: holding.entryT,
          exitT: bar.t,
          entryPrice: holding.entryPrice,
          exitPrice: price,
          sizeUsd: holding.costUsd,
          pnlUsd,
          pnlPct: (pnlUsd / holding.costUsd) * 100,
        });
        positions.delete(sym);
        tradesToday += 1;
        volumeTodayUsd += holding.costUsd;
        continue;
      }

      // Enter on a buy signal, if we have capacity.
      if (!holding && decision.direction === 'buy' && positions.size < cfg.maxPositions) {
        const sizeUsd = sizePosition(decision, cash, risk);
        const guard = checkGuardrails(
          {
            conviction: decision.conviction,
            tradeUsd: sizeUsd,
            currentDrawdownPct: ddPct,
            tradesToday,
            volumeTodayUsd,
            tokenSymbol: sym,
            // The series defines the tradable universe; the live allowlist gate
            // is enforced separately in production.
            isTokenEligible: true,
          },
          risk,
        );
        if (sizeUsd > 0 && guard.allowed && sizeUsd <= cash) {
          const amount = (sizeUsd * (1 - txCostRate)) / price;
          cash -= sizeUsd;
          positions.set(sym, { symbol: sym, amount, entryPrice: price, entryT: bar.t, costUsd: sizeUsd });
          tradesToday += 1;
          volumeTodayUsd += sizeUsd;
        }
      }
    }

    equityCurve.push({ t: bar.t, equity: equityAt(bar) });
  }

  // Liquidate any open positions at the final bar.
  const last = series[series.length - 1];
  if (last) {
    for (const p of positions.values()) {
      const price = priceOf(last, p.symbol);
      const proceeds = p.amount * price * (1 - txCostRate);
      cash += proceeds;
      const pnlUsd = proceeds - p.costUsd;
      closedTrades.push({
        symbol: p.symbol,
        entryT: p.entryT,
        exitT: last.t,
        entryPrice: p.entryPrice,
        exitPrice: price,
        sizeUsd: p.costUsd,
        pnlUsd,
        pnlPct: (pnlUsd / p.costUsd) * 100,
      });
    }
    positions.clear();
  }

  const startingEquity = cfg.startingCashUsd;
  const endingEquity = cash;
  const wins = closedTrades.filter((t) => t.pnlUsd > 0).length;

  return {
    startingEquity,
    endingEquity,
    totalReturnPct: ((endingEquity - startingEquity) / startingEquity) * 100,
    maxDrawdownPct,
    numTrades: closedTrades.length,
    winRatePct: closedTrades.length ? (wins / closedTrades.length) * 100 : 0,
    avgTradePnlPct: closedTrades.length
      ? closedTrades.reduce((s, t) => s + t.pnlPct, 0) / closedTrades.length
      : 0,
    bars: series.length,
    equityCurve,
    closedTrades,
  };
}

/** Render a compact, human-readable backtest report. */
export function formatReport(r: BacktestResult): string {
  return [
    `bars:            ${r.bars}`,
    `starting equity: $${r.startingEquity.toFixed(2)}`,
    `ending equity:   $${r.endingEquity.toFixed(2)}`,
    `total return:    ${r.totalReturnPct >= 0 ? '+' : ''}${r.totalReturnPct.toFixed(2)}%`,
    `max drawdown:    ${r.maxDrawdownPct.toFixed(2)}%`,
    `trades:          ${r.numTrades}`,
    `win rate:        ${r.winRatePct.toFixed(1)}%`,
    `avg trade pnl:   ${r.avgTradePnlPct >= 0 ? '+' : ''}${r.avgTradePnlPct.toFixed(2)}%`,
  ].join('\n');
}
