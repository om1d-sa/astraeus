import type { MarketContext, TokenSignals } from '../strategy/types';

/** One time-slice of the market: per-token signals + market-wide context. */
export interface Bar {
  /** Bar timestamp (ms since epoch). */
  t: number;
  market: MarketContext;
  /** Per-token signals, keyed by symbol. */
  tokens: Record<string, TokenSignals>;
}

/** An ordered (ascending time) sequence of bars — the backtest input. */
export type Series = Bar[];

export interface BacktestConfig {
  startingCashUsd: number;
  /** Taker fee per trade, in basis points. */
  feeBps: number;
  /** Assumed slippage per trade, in basis points. */
  slippageBps: number;
  /** Max concurrent open positions. */
  maxPositions: number;
}

/** A completed round-trip (entry → exit). */
export interface ClosedTrade {
  symbol: string;
  entryT: number;
  exitT: number;
  entryPrice: number;
  exitPrice: number;
  sizeUsd: number;
  pnlUsd: number;
  pnlPct: number;
}

export interface BacktestResult {
  startingEquity: number;
  endingEquity: number;
  totalReturnPct: number;
  /** Peak-to-trough equity drawdown (%) — the competition's DQ risk gate. */
  maxDrawdownPct: number;
  numTrades: number;
  winRatePct: number;
  avgTradePnlPct: number;
  bars: number;
  equityCurve: Array<{ t: number; equity: number }>;
  closedTrades: ClosedTrade[];
}
