/**
 * Core strategy types — the shared "brain" used by both hackathon tracks.
 *
 * Track 2 packages the pure {@link evaluate} function as a backtestable Skill.
 * Track 1 runs the same function live, feeding its {@link Decision} through the
 * risk guardrails and then into TWAK execution.
 *
 * Everything here is plain data so the strategy stays pure and deterministic
 * (same inputs → same decision), which is what makes backtesting meaningful.
 */

export type Direction = 'buy' | 'sell' | 'hold';

/**
 * Per-token market signals. Mirrors what the CoinMarketCap AI Agent Hub exposes
 * (it serves pre-computed RSI/MACD/EMA plus price, funding and volume). All
 * indicator fields are optional so the strategy degrades gracefully when a
 * particular datum is missing — weights renormalize over whatever is present.
 */
export interface TokenSignals {
  symbol: string;
  priceUsd: number;
  /** Relative Strength Index (0-100). */
  rsi14?: number;
  /** MACD histogram value; sign = momentum direction. */
  macdHist?: number;
  /** Fast EMA (e.g. 12-period). */
  emaFast?: number;
  /** Slow EMA (e.g. 26-period). */
  emaSlow?: number;
  /** Perp funding rate as a fraction (e.g. 0.0001 = 1 bp). Positive = crowded longs. */
  fundingRate?: number;
  /** 24h price change, percent. */
  change24hPct?: number;
  /** 24h traded volume in USD (liquidity gate). */
  volume24hUsd?: number;
}

/** Market-wide context shared across tokens. */
export interface MarketContext {
  /** CMC Fear & Greed Index (0 = extreme fear, 100 = extreme greed). */
  fearGreed?: number;
}

/** Tunable strategy parameters (exposed so they can be optimized / backtested). */
export interface StrategyParams {
  /** RSI level above which a token is considered overbought. */
  rsiOverbought: number;
  /** RSI level below which a token is considered oversold. */
  rsiOversold: number;
  /** Funding magnitude treated as "extreme" (contrarian signal saturates here). */
  fundingExtreme: number;
  /** EMA gap (fraction of slow EMA) that maps to full-strength trend signal. */
  emaFullTrendGap: number;
  /** |score| at which conviction reaches 100. */
  scoreForFullConviction: number;
  /** |score| at/above which the agent acts; below → hold. */
  actThreshold: number;
  /** Minimum 24h USD volume to consider a token tradable. */
  minVolumeUsd: number;
  /** Sub-signal weights (need not sum to 1 — they are renormalized over present signals). */
  weights: {
    trend: number;
    macd: number;
    rsi: number;
    sentiment: number;
    funding: number;
  };
}

/** A single human-readable signal contribution, for transparent rationale. */
export interface SignalContribution {
  name: string;
  /** Normalized signal value in [-1, 1] (positive = bullish). */
  value: number;
  weight: number;
  note: string;
}

/** The strategy's output for one token. */
export interface Decision {
  symbol: string;
  direction: Direction;
  /** 0-100. */
  conviction: number;
  /** Raw composite score in [-1, 1]. */
  score: number;
  /** Why — one line per contributing signal. */
  contributions: SignalContribution[];
}
