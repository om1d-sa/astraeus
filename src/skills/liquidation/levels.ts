/**
 * Quantitative liquidation map — for each asset, the price levels where leveraged
 * LONG positions (price falls) and SHORT positions (price rises) get liquidated, with
 * a probability that price TOUCHES each level within a horizon. No LLM "read": pure
 * math from current price + a volatility estimate.
 *
 * Levels: a perp position at leverage L is liquidated ~when price moves 1/L against it
 * (maintenance margin ignored — a small, conservative simplification), so the standard
 * 100×/50×/25× leverage ladder maps to ∓1% / ∓2% / ∓4% from spot.
 *
 * Probability: under a driftless geometric-Brownian-motion model, the chance price
 * touches a barrier at log-distance d any time within horizon T is, by the reflection
 * principle, P = 2·Φ(−d / (σ·√T)) — where σ is the daily volatility and T is in days.
 * This is a touch (not close-beyond) probability, which is what matters for liquidation.
 */

/** Leverage tiers shown, high→low (→ 1%, 2%, 4% from spot). */
export const LEVERAGE_TIERS = [100, 50, 25] as const;

/** Per-asset baseline daily volatility (fraction) — a floor when the recent move is quiet. */
const SIGMA_BASELINE: Record<string, number> = {
  BTC: 0.025,
  ETH: 0.032,
  BNB: 0.03,
};
const SIGMA_BASELINE_DEFAULT = 0.05;

/** Standard normal CDF via an Abramowitz-Stegun erf approximation (max err ~1.5e-7). */
export function normCdf(x: number): number {
  const t = 1 / (1 + (0.3275911 * Math.abs(x)) / Math.SQRT2);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) *
      t +
      0.254829592) *
      t *
      Math.exp((-x * x) / 2);
  return x >= 0 ? 0.5 * (1 + y * Math.sign(x)) : 0.5 * (1 - y);
}

/**
 * Estimate forward daily volatility (fraction) for a symbol. Uses the magnitude of the
 * recent 24h move as a live signal, floored by a per-asset baseline so a quiet day can't
 * collapse probabilities to ~0, and capped so an extreme day can't peg them to ~100%.
 */
export function estimateDailySigma(
  symbol: string,
  change24hPct: number | undefined,
): number {
  const base = SIGMA_BASELINE[symbol.toUpperCase()] ?? SIGMA_BASELINE_DEFAULT;
  const realized =
    typeof change24hPct === "number" && Number.isFinite(change24hPct)
      ? Math.abs(change24hPct) / 100
      : 0;
  return Math.min(0.25, Math.max(base, realized));
}

export interface LiqLevel {
  /** Leverage tier (100, 50, 25). */
  leverage: number;
  /** Signed distance from spot, in percent (negative = long liq below, positive = short liq above). */
  distancePct: number;
  /** The liquidation price. */
  price: number;
  /** Probability (0..1) price touches this level within the horizon. */
  touchProb: number;
}

export interface AssetLiquidationMap {
  symbol: string;
  price: number;
  change24hPct?: number;
  /** Daily volatility used, in percent. */
  sigmaDailyPct: number;
  /** Long liquidations (price falls), high→low leverage (nearest→farthest). */
  longs: LiqLevel[];
  /** Short liquidations (price rises), high→low leverage. */
  shorts: LiqLevel[];
}

/** Build the long/short liquidation ladder for one asset over `horizonDays` (default 1). */
export function buildAssetLiquidationMap(
  symbol: string,
  price: number,
  change24hPct: number | undefined,
  horizonDays = 1,
): AssetLiquidationMap {
  const sigmaDaily = estimateDailySigma(symbol, change24hPct);
  const sigmaT = sigmaDaily * Math.sqrt(horizonDays);
  const level = (leverage: number, dir: -1 | 1): LiqLevel => {
    const liqPrice = price * (1 + dir / leverage);
    const d = Math.abs(Math.log(liqPrice / price)); // log-distance to the barrier
    const touchProb = Math.min(0.99, 2 * normCdf(-d / sigmaT));
    return {
      leverage,
      distancePct: (dir * 100) / leverage,
      price: liqPrice,
      touchProb,
    };
  };
  return {
    symbol: symbol.toUpperCase(),
    price,
    change24hPct,
    sigmaDailyPct: sigmaDaily * 100,
    longs: LEVERAGE_TIERS.map((l) => level(l, -1)),
    shorts: LEVERAGE_TIERS.map((l) => level(l, 1)),
  };
}

const fmtUsd = (n: number): string => {
  const dp = n >= 1000 ? 0 : n >= 1 ? 2 : 6;
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;
};
const fmtProb = (p: number): string => `~${Math.round(p * 100)}%`;

/** Render the maps as a compact, numeric, GitHub-markdown block (no prose). */
export function formatLiquidationMap(
  maps: AssetLiquidationMap[],
  horizonLabel = "24h",
): string {
  const out: string[] = [];
  for (const m of maps) {
    const chg =
      typeof m.change24hPct === "number"
        ? `, 24h ${m.change24hPct >= 0 ? "+" : ""}${m.change24hPct.toFixed(1)}%`
        : "";
    out.push(
      `**${m.symbol} — ${fmtUsd(m.price)}** (σ≈${m.sigmaDailyPct.toFixed(1)}%/day${chg})`,
    );
    out.push("Long liqs (price ↓):");
    for (const l of m.longs)
      out.push(
        `- ${l.leverage}× → ${fmtUsd(l.price)} (${l.distancePct.toFixed(0)}%) · ${fmtProb(l.touchProb)}`,
      );
    out.push("Short liqs (price ↑):");
    for (const l of m.shorts)
      out.push(
        `- ${l.leverage}× → ${fmtUsd(l.price)} (+${l.distancePct.toFixed(0)}%) · ${fmtProb(l.touchProb)}`,
      );
    out.push("");
  }
  out.push(
    `_Touch probability over ${horizonLabel}; driftless vol model, maintenance margin ignored._`,
  );
  return out.join("\n").trim();
}
