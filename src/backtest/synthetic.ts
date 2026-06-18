/**
 * Reproducible synthetic market-data generator for backtests.
 *
 * Produces a {@link Series} with realistic, internally-consistent indicators:
 * prices follow a random walk, and EMA/RSI/MACD are computed FROM those prices
 * (so the strategy sees coherent signals, not random noise). Funding and Fear &
 * Greed are simulated as bounded random walks.
 *
 * This lets the backtester run with zero credentials. Live CoinMarketCap history
 * plugs into the exact same Series shape, so the engine code never changes.
 */

import type { TokenSignals } from '../strategy/types';
import type { Series } from './types';

/** Deterministic PRNG (mulberry32) so a given seed always yields the same series. */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const emaStep = (prev: number, price: number, period: number): number => {
  const k = 2 / (period + 1);
  return prev + k * (price - prev);
};

export interface SyntheticOpts {
  seed?: number;
  bars?: number;
  startPrice?: number;
  /** Per-bar drift (expected return). */
  driftPerBar?: number;
  /** Per-bar volatility (stdev of return). */
  volPerBar?: number;
}

export function generateSyntheticSeries(symbols: string[], opts: SyntheticOpts = {}): Series {
  const { seed = 42, bars = 500, startPrice = 100, driftPerBar = 0.0003, volPerBar = 0.02 } = opts;
  const rnd = mulberry32(seed);
  const stepMs = 3_600_000; // hourly bars
  const t0 = Date.UTC(2026, 0, 1);

  const state = symbols.map((sym, i) => ({
    sym,
    price: startPrice * (1 + i * 0.1),
    emaF: startPrice * (1 + i * 0.1),
    emaS: startPrice * (1 + i * 0.1),
    macdF: startPrice * (1 + i * 0.1),
    macdS: startPrice * (1 + i * 0.1),
    gains: [] as number[],
    losses: [] as number[],
  }));

  let fearGreed = 50;
  const series: Series = [];

  for (let b = 0; b < bars; b++) {
    // Fear & Greed random walk, clamped to [0, 100].
    fearGreed = Math.max(0, Math.min(100, fearGreed + (rnd() - 0.5) * 8));

    const tokens: Record<string, TokenSignals> = {};
    for (const s of state) {
      // Approx-normal shock via sum of two uniforms, then a random-walk return.
      const z = rnd() + rnd() - 1;
      const ret = driftPerBar + volPerBar * z;
      const prevPrice = s.price;
      s.price = Math.max(0.0001, s.price * (1 + ret));

      s.emaF = emaStep(s.emaF, s.price, 12);
      s.emaS = emaStep(s.emaS, s.price, 26);
      s.macdF = emaStep(s.macdF, s.price, 12);
      s.macdS = emaStep(s.macdS, s.price, 26);
      const macdHist = s.macdF - s.macdS;

      const change = s.price - prevPrice;
      s.gains.push(Math.max(0, change));
      s.losses.push(Math.max(0, -change));
      if (s.gains.length > 14) {
        s.gains.shift();
        s.losses.shift();
      }
      const avgGain = s.gains.reduce((a, c) => a + c, 0) / s.gains.length;
      const avgLoss = s.losses.reduce((a, c) => a + c, 0) / s.losses.length || 1e-9;
      const rsi14 = 100 - 100 / (1 + avgGain / avgLoss);

      tokens[s.sym] = {
        symbol: s.sym,
        priceUsd: s.price,
        rsi14,
        macdHist,
        emaFast: s.emaF,
        emaSlow: s.emaS,
        fundingRate: (rnd() - 0.5) * 0.0006,
        change24hPct: (s.price / prevPrice - 1) * 100,
        volume24hUsd: 5_000_000,
      };
    }

    series.push({ t: t0 + b * stepMs, market: { fearGreed: Math.round(fearGreed) }, tokens });
  }

  return series;
}
