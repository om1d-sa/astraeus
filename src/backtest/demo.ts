/**
 * Backtest demo — runs the Astraeus strategy over a reproducible synthetic
 * dataset and prints a performance report. Run with: `bun src/backtest/demo.ts`.
 *
 * Swap `generateSyntheticSeries` for a CoinMarketCap-history loader (same Series
 * shape) to backtest on real data once the CMC connection is wired.
 */
import { formatReport, generateSyntheticSeries, runBacktest } from './index';

const symbols = ['BTC', 'ETH', 'BNB', 'CAKE', 'TWT'];
const series = generateSyntheticSeries(symbols, {
  seed: 7,
  bars: 720, // 30 days of hourly bars
  startPrice: 100,
  driftPerBar: 0.0004,
  volPerBar: 0.018,
});

const result = runBacktest(series);

console.log(`Astraeus backtest — ${symbols.join(', ')} over ${series.length} hourly bars (synthetic)\n`);
console.log(formatReport(result));
