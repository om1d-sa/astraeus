/**
 * Autonomous loop demo — paper trading on LIVE CoinMarketCap data.
 * Run with: `bun src/agent/demo.ts`.
 *
 * No wallet, no real funds. Swap PaperExecutor for the Trust Wallet Agent Kit
 * executor (same interface) to go live for Track 1.
 */
import { CmcDataProvider } from '../data/cmc';
import { PaperExecutor } from '../exec/paper';
import { AutonomousTrader } from './loop';

const symbols = ['ETH', 'BNB', 'CAKE', 'TWT', 'LINK'];
const provider = new CmcDataProvider();
const executor = new PaperExecutor({ startingCashUsd: 100 });
const trader = new AutonomousTrader(provider, executor, { symbols });

console.log('Astraeus autonomous loop — paper trading on live CMC data\n');

for (let i = 0; i < 3; i++) {
  const r = await trader.tick();
  const pf = await executor.getPortfolio();
  console.log(
    `Tick ${r.tick}: equity $${r.equityUsd.toFixed(2)} | cash $${pf.cashUsd.toFixed(2)} | drawdown ${r.drawdownPct.toFixed(2)}%`,
  );
  for (const a of r.actions) console.log(`   • ${a}`);
  const hold = pf.holdings.map((h) => `${h.symbol} $${h.valueUsd.toFixed(2)}`).join(', ') || '(none)';
  console.log(`   holdings: ${hold}\n`);
}
