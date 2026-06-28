/**
 * CMC AI Agent Hub enrichment for the ETH forecast.
 *
 * Adds CoinMarketCap signals — current price, technicals (RSI/MACD/EMA), market
 * regime (total cap, BTC dominance), and Fear & Greed — as SUPPLEMENTARY context.
 * The options/derivatives data stays the primary basis (~60% weight); this is the
 * remaining ~40%. Every piece is best-effort (independent try/catch) so a single
 * unavailable endpoint never blocks the forecast.
 */
import type { CmcDataProvider } from "../../data/cmc";

export interface CmcForecastContext {
  context: string;
  priceUsd?: number;
}

export async function fetchCmcForecastContext(
  provider: CmcDataProvider,
  asset: string,
): Promise<CmcForecastContext | undefined> {
  // Fetch all four CMC REST calls in PARALLEL (each best-effort) so their times
  // don't accumulate — total ≈ the slowest, not the sum.
  const [sig, t, g, mc] = await Promise.all([
    provider.getTokenSignals([asset]).catch(() => undefined),
    provider.getTechnicals(asset).catch(() => undefined),
    provider.getGlobalMetrics().catch(() => undefined),
    provider.getMarketContext().catch(() => ({}) as { fearGreed?: number }),
  ]);

  const lines: string[] = [];
  let priceUsd: number | undefined;

  // Current price (CoinMarketCap)
  const p = sig?.[0]?.priceUsd;
  if (p && p > 0) {
    priceUsd = p;
    lines.push(
      `- Current ${asset} price (CoinMarketCap Agent Hub): $${p.toLocaleString()}`,
    );
  }

  // Technicals (RSI / MACD / EMA computed from CMC OHLCV)
  if (t && t.points >= 14) {
    const macdLabel =
      t.macd === undefined
        ? "n/a"
        : t.macd > 0
          ? `bullish (+${t.macd.toFixed(1)})`
          : `bearish (${t.macd.toFixed(1)})`;
    lines.push(
      `- ${asset} technicals (CMC daily): RSI14 ${t.rsi14?.toFixed(0) ?? "n/a"}, MACD ${macdLabel}, EMA12 ${t.ema12?.toFixed(0) ?? "n/a"} vs EMA26 ${t.ema26?.toFixed(0) ?? "n/a"}`,
    );
  }

  // Market regime (global metrics) — for risk-off awareness
  if (g) {
    const chg =
      g.marketCapChange24hPct !== undefined
        ? ` (${g.marketCapChange24hPct >= 0 ? "+" : ""}${g.marketCapChange24hPct.toFixed(1)}% 24h)`
        : "";
    lines.push(
      `- Market regime (CMC): total cap $${(g.totalMarketCapUsd / 1e9).toFixed(0)}B${chg}, BTC dominance ${g.btcDominance.toFixed(1)}%`,
    );
  }

  // Fear & Greed
  if (mc?.fearGreed !== undefined)
    lines.push(`- Fear & Greed (CMC): ${mc.fearGreed}/100`);

  if (lines.length === 0) return undefined;
  return {
    priceUsd,
    context: `COINMARKETCAP AGENT HUB CONTEXT (supplementary — the options/derivatives data remains the primary basis):\n${lines.join("\n")}`,
  };
}
