/**
 * Astraeus strategy core.
 *
 * A transparent, multi-signal trend + sentiment strategy:
 *   - Trend:      EMA(fast) vs EMA(slow) gap, confirmed by MACD histogram.
 *   - Mean-rev:   RSI fades extremes (overbought → bearish tilt, oversold → bullish).
 *   - Sentiment:  CMC Fear & Greed, used contrarian (extreme fear → bullish).
 *   - Positioning:perp funding, used contrarian (crowded longs → bearish).
 *
 * Each sub-signal is normalized to [-1, 1] (positive = bullish), weighted, and
 * combined into a composite score in [-1, 1]. Missing inputs are skipped and the
 * remaining weights renormalize, so the agent still decides on partial data.
 *
 * Pure and deterministic: same inputs → same Decision. That is what lets Track 2
 * backtest it and Track 1 trust it live.
 */

import type {
  Decision,
  MarketContext,
  SignalContribution,
  StrategyParams,
  TokenSignals,
} from './types';
import { getRiskConfig, type RiskConfig } from '../config/risk';

export const DEFAULT_PARAMS: StrategyParams = {
  rsiOverbought: 70,
  rsiOversold: 30,
  fundingExtreme: 0.0005, // 5 bps per funding interval
  emaFullTrendGap: 0.02, // 2% EMA gap → full-strength trend
  scoreForFullConviction: 0.6,
  actThreshold: 0.2,
  minVolumeUsd: 50_000,
  weights: {
    trend: 0.4,
    macd: 0.15,
    rsi: 0.15,
    sentiment: 0.15,
    funding: 0.15,
  },
};

const clamp = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, x));

/**
 * Evaluate one token against the strategy.
 * @returns a {@link Decision} with direction, conviction (0-100), and a per-signal rationale.
 */
export function evaluate(
  signals: TokenSignals,
  market: MarketContext = {},
  params: StrategyParams = DEFAULT_PARAMS,
): Decision {
  const contributions: SignalContribution[] = [];

  // --- Trend: EMA fast vs slow ---
  if (signals.emaFast !== undefined && signals.emaSlow !== undefined && signals.emaSlow !== 0) {
    const gap = (signals.emaFast - signals.emaSlow) / signals.emaSlow;
    const value = clamp(gap / params.emaFullTrendGap, -1, 1);
    contributions.push({
      name: 'trend',
      value,
      weight: params.weights.trend,
      note: `EMA gap ${(gap * 100).toFixed(2)}% (${value >= 0 ? 'up' : 'down'}trend)`,
    });
  }

  // --- Momentum confirmation: MACD histogram sign ---
  if (signals.macdHist !== undefined) {
    const value = clamp(Math.sign(signals.macdHist) * Math.min(1, Math.abs(signals.macdHist) / (signals.priceUsd * 0.01 || 1)), -1, 1);
    contributions.push({
      name: 'macd',
      value,
      weight: params.weights.macd,
      note: `MACD hist ${signals.macdHist >= 0 ? 'positive' : 'negative'}`,
    });
  }

  // --- Mean reversion: RSI fades extremes ---
  if (signals.rsi14 !== undefined) {
    // Map RSI to [-1, 1]: oversold (low) → bullish (+), overbought (high) → bearish (-)
    const value = clamp((50 - signals.rsi14) / (50 - params.rsiOversold), -1, 1);
    const tag = signals.rsi14 >= params.rsiOverbought ? 'overbought' : signals.rsi14 <= params.rsiOversold ? 'oversold' : 'neutral';
    contributions.push({ name: 'rsi', value, weight: params.weights.rsi, note: `RSI ${signals.rsi14.toFixed(0)} (${tag})` });
  }

  // --- Sentiment: Fear & Greed, contrarian ---
  if (market.fearGreed !== undefined) {
    const value = clamp((50 - market.fearGreed) / 50, -1, 1);
    const tag = market.fearGreed <= 25 ? 'extreme fear' : market.fearGreed >= 75 ? 'extreme greed' : 'neutral';
    contributions.push({ name: 'sentiment', value, weight: params.weights.sentiment, note: `F&G ${market.fearGreed} (${tag})` });
  }

  // --- Positioning: funding, contrarian (crowded longs → bearish) ---
  if (signals.fundingRate !== undefined) {
    const value = clamp(-signals.fundingRate / params.fundingExtreme, -1, 1);
    contributions.push({
      name: 'funding',
      value,
      weight: params.weights.funding,
      note: `funding ${(signals.fundingRate * 100).toFixed(3)}% (${signals.fundingRate >= 0 ? 'longs pay' : 'shorts pay'})`,
    });
  }

  // --- Combine: weighted average over PRESENT signals (renormalized) ---
  const totalWeight = contributions.reduce((s, c) => s + c.weight, 0);
  const score = totalWeight > 0 ? clamp(contributions.reduce((s, c) => s + c.value * c.weight, 0) / totalWeight, -1, 1) : 0;

  // Liquidity gate: if volume is known and too thin, force hold.
  const illiquid = signals.volume24hUsd !== undefined && signals.volume24hUsd < params.minVolumeUsd;

  let direction: Decision['direction'] = 'hold';
  if (!illiquid) {
    if (score >= params.actThreshold) direction = 'buy';
    else if (score <= -params.actThreshold) direction = 'sell';
  }

  const conviction = Math.round(clamp(Math.abs(score) / params.scoreForFullConviction, 0, 1) * 100);

  if (illiquid) {
    contributions.push({ name: 'liquidity', value: 0, weight: 0, note: `volume $${signals.volume24hUsd?.toLocaleString()} < min — hold` });
  }

  return { symbol: signals.symbol, direction, conviction, score, contributions };
}

/**
 * Translate a Decision into a USD trade size, bounded by the risk config.
 * Conviction scales the size; the per-trade cap is the hard ceiling. The final
 * guardrail check (checkGuardrails) still has the last word before execution.
 *
 * @param availableCashUsd cash leg available to deploy (stablecoin balance).
 */
export function sizePosition(
  decision: Decision,
  availableCashUsd: number,
  cfg: RiskConfig = getRiskConfig(),
): number {
  if (decision.direction === 'hold' || decision.conviction < cfg.minConviction) return 0;
  const convScaled = (decision.conviction / 100) * availableCashUsd;
  const size = Math.min(cfg.maxTradeUsd, convScaled);
  return Math.max(0, Math.round(size * 100) / 100);
}

/** One-line human summary of a decision, for logs and chat. */
export function explain(decision: Decision): string {
  const top = [...decision.contributions]
    .filter((c) => c.weight > 0)
    .sort((a, b) => Math.abs(b.value * b.weight) - Math.abs(a.value * a.weight))
    .slice(0, 3)
    .map((c) => c.note)
    .join('; ');
  return `${decision.symbol}: ${decision.direction.toUpperCase()} @ ${decision.conviction}% conviction (score ${decision.score.toFixed(2)}) — ${top}`;
}
