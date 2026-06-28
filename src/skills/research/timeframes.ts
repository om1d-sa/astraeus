/**
 * Multi-timeframe technical read for the RESEARCH card.
 *
 * Turns the per-timeframe technicals (1h / 4h / daily / weekly) CMC returns into ONE
 * directional verdict a trader can act on: a bullish/bearish/neutral bias, a confidence
 * score, and a swing price target. Pure math — no LLM, no network — so it is fully
 * deterministic and unit-testable.
 *
 * Method:
 * - Each timeframe with ≥14 closes gets a score in -1..1 from its RSI (distance from 50,
 *   with overbought/oversold softened toward mean-reversion) and its MACD sign+slope
 *   (EMA12−EMA26, normalized by price so the magnitude is timeframe/asset-agnostic).
 * - The verdict score is the weighted blend across timeframes (slower frames carry more
 *   weight) plus an optional CMC-skill sentiment input. Confidence rises with both the
 *   magnitude of the blend and the agreement of the contributing frames.
 * - The price target projects the daily realized-volatility proxy out over a short swing
 *   horizon in the bias direction, scaled by confidence and capped.
 */
import type { CmcTechnicals, MultiTimeframeTechnicals, Timeframe } from "../../data/cmc";
import { TIMEFRAMES } from "../../data/cmc";

const clamp = (x: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(hi, x));

/** Minimum closes for a timeframe to score (RSI14 needs 15; we require a full window). */
export const MIN_POINTS = 14;

/** Per-timeframe blend weights — slower frames anchor the trend, faster frames time it. */
export const TF_WEIGHT: Record<Timeframe, number> = {
  "1h": 0.15,
  "4h": 0.25,
  "1D": 0.35,
  "1W": 0.25,
};

/** Weight given to an optional CMC-skill sentiment input, relative to the timeframes. */
export const SKILL_WEIGHT = 0.3;

/**
 * Swing-target horizon per timeframe: the anchor frame's mean move × this × a
 * confidence-scaled factor, capped by MAX_TARGET. Tuned so each frame projects a few
 * of its own candles ahead (≈ a day on 1h/4h, ≈ a week on daily).
 */
const HORIZON_FACTOR: Record<Timeframe, number> = {
  "1h": 4,
  "4h": 4,
  "1D": 5,
  "1W": 4,
};
const MAX_TARGET = 0.3; // never project more than ±30%

/** Preference order for which frame's volatility anchors the price target. */
const TARGET_ANCHOR_ORDER: Timeframe[] = ["1D", "1W", "4h", "1h"];

export type Bias = "bullish" | "bearish" | "neutral";

/** One timeframe distilled to the inputs the verdict needs. */
export interface TimeframeReading {
  label: Timeframe;
  rsi14?: number;
  /** EMA12 − EMA26 in price units. */
  macd?: number;
  /** Last close — normalizes MACD into a price-relative slope. */
  lastClose?: number;
  /** Mean abs close-to-close % move (fraction). */
  volPct?: number;
  /** Data points available; below {@link MIN_POINTS} the frame is skipped. */
  points: number;
}

export interface ResearchVerdict {
  bias: Bias;
  /** 0..1 — how strong and aligned the read is. */
  confidence: number;
  /** Blended directional score, -1 (bearish) … +1 (bullish). */
  score: number;
  /** Projected swing target in the bias direction (absent when neutral / no vol data). */
  targetPrice?: number;
  /** Target as a signed fraction of current price (e.g. +0.08 = +8%). */
  targetPct?: number;
  /** Per-timeframe contributions used, for display/inspection. */
  contributions: Array<{ label: Timeframe | "skill"; score: number; weight: number }>;
}

/** Adapt a {@link CmcTechnicals} into a {@link TimeframeReading} for `label`. */
export function readingFromTechnicals(
  label: Timeframe,
  tech: CmcTechnicals,
): TimeframeReading {
  return {
    label,
    rsi14: tech.rsi14,
    macd: tech.macd,
    lastClose: tech.lastClose,
    volPct: tech.volPct,
    points: tech.points,
  };
}

/** All available timeframe readings from a {@link MultiTimeframeTechnicals} bundle, fast→slow. */
export function readingsFromMulti(multi: MultiTimeframeTechnicals): TimeframeReading[] {
  return TIMEFRAMES.flatMap((tf) => {
    const tech = multi[tf];
    return tech ? [readingFromTechnicals(tf, tech)] : [];
  });
}

/**
 * Directional score for ONE timeframe in -1..1, or undefined when the frame lacks enough
 * data (or carries no usable indicator). Combines RSI (trend strength, with extremes
 * dampened toward exhaustion) and MACD (price-normalized momentum sign+slope).
 */
export function timeframeScore(r: TimeframeReading): number | undefined {
  if (r.points < MIN_POINTS) return undefined;
  const parts: number[] = [];

  if (r.rsi14 !== undefined && Number.isFinite(r.rsi14)) {
    let rsiScore = (r.rsi14 - 50) / 50; // 0→-1, 50→0, 100→+1
    // Overbought/oversold: still directional, but cap to flag exhaustion risk.
    if (r.rsi14 >= 80) rsiScore = 0.6;
    else if (r.rsi14 <= 20) rsiScore = -0.6;
    parts.push(clamp(rsiScore, -1, 1));
  }

  if (r.macd !== undefined && Number.isFinite(r.macd)) {
    // Normalize the EMA gap by price so the magnitude is comparable across assets and
    // timeframes; a ~2% gap saturates the score. Falls back to the raw sign if no price.
    const macdScore =
      r.lastClose && r.lastClose > 0
        ? clamp((r.macd / r.lastClose) * 50, -1, 1)
        : Math.sign(r.macd);
    parts.push(macdScore);
  }

  if (parts.length === 0) return undefined;
  return clamp(parts.reduce((a, b) => a + b, 0) / parts.length, -1, 1);
}

/**
 * Blend the timeframe readings (and an optional CMC-skill sentiment) into one verdict.
 * Always returns a verdict; with no scorable input it is a zero-confidence neutral.
 */
export function synthesizeVerdict(
  readings: TimeframeReading[],
  price: number,
  opts: { skillSentiment?: number } = {},
): ResearchVerdict {
  const contributions: ResearchVerdict["contributions"] = [];
  let weightedSum = 0;
  let weightSum = 0;

  for (const r of readings) {
    const s = timeframeScore(r);
    if (s === undefined) continue;
    const w = TF_WEIGHT[r.label];
    contributions.push({ label: r.label, score: s, weight: w });
    weightedSum += s * w;
    weightSum += w;
  }

  if (
    opts.skillSentiment !== undefined &&
    Number.isFinite(opts.skillSentiment)
  ) {
    const s = clamp(opts.skillSentiment, -1, 1);
    contributions.push({ label: "skill", score: s, weight: SKILL_WEIGHT });
    weightedSum += s * SKILL_WEIGHT;
    weightSum += SKILL_WEIGHT;
  }

  if (weightSum === 0) {
    return { bias: "neutral", confidence: 0, score: 0, contributions };
  }

  const score = clamp(weightedSum / weightSum, -1, 1);
  const bias: Bias = score > 0.15 ? "bullish" : score < -0.15 ? "bearish" : "neutral";

  // Agreement: weighted share of contributors pointing the same way as the blend.
  const sign = Math.sign(score);
  const agreeWeight =
    sign === 0
      ? 0
      : contributions
          .filter((c) => Math.sign(c.score) === sign)
          .reduce((a, c) => a + c.weight, 0);
  const agreement = sign === 0 ? 0.5 : agreeWeight / weightSum;
  const confidence = clamp(Math.abs(score) * 0.5 + agreement * 0.5, 0, 1);

  // Swing target: project the anchor frame's realized vol over its horizon, in the bias
  // direction. Anchor prefers the daily frame but falls back to whatever frame is present
  // (so a single-timeframe request, e.g. "research X on 4h", still gets a target).
  const anchor = pickTargetAnchor(readings);
  let targetPrice: number | undefined;
  let targetPct: number | undefined;
  if (bias !== "neutral" && price > 0 && anchor?.volPct) {
    targetPct = clamp(
      sign * anchor.volPct * HORIZON_FACTOR[anchor.label] * (0.4 + 0.6 * confidence),
      -MAX_TARGET,
      MAX_TARGET,
    );
    targetPrice = price * (1 + targetPct);
  }

  return { bias, confidence, score, targetPrice, targetPct, contributions };
}

/** The frame whose volatility anchors the price target (first present, by preference). */
function pickTargetAnchor(
  readings: TimeframeReading[],
): TimeframeReading | undefined {
  for (const label of TARGET_ANCHOR_ORDER) {
    const r = readings.find((x) => x.label === label && x.volPct && x.volPct > 0);
    if (r) return r;
  }
  return undefined;
}

/**
 * Parse a requested chart timeframe from the message — "research X on daily", "4h", "weekly".
 * Returns undefined when none is named, so the caller shows the full multi-timeframe view.
 * 4h is checked before 1h (so "4 hour" doesn't match "hour"); weekly before daily.
 */
export function parseTimeframe(text: string): Timeframe | undefined {
  const t = text.toLowerCase();
  if (/\b(4\s*-?\s*h(our)?s?|four[\s-]?hour|4hr|4h)\b/.test(t)) return "4h";
  if (/\b(1\s*-?\s*h(our)?|hourly|1hr|1h|60\s*min)\b/.test(t)) return "1h";
  if (/\b(week(ly)?|7\s*-?\s*d(ay)?s?|1w)\b/.test(t)) return "1W";
  if (/\b(day|daily|24\s*-?\s*h(our)?s?|1d)\b/.test(t)) return "1D";
  return undefined;
}

/** Emoji marker for a bias — 🟢 bullish · 🔴 bearish · ⚪ neutral. */
export function biasEmoji(bias: Bias): string {
  return bias === "bullish" ? "🟢" : bias === "bearish" ? "🔴" : "⚪";
}

/** Price formatted with decimals that suit its magnitude (sub-$1 tokens need more). */
function fmtPrice(p: number): string {
  const digits = p >= 100 ? 2 : p >= 1 ? 3 : p >= 0.01 ? 5 : 8;
  return `$${p.toLocaleString(undefined, { maximumFractionDigits: digits })}`;
}

/**
 * MACD as a PRICE-NORMALIZED label, e.g. `bullish (+0.34%)`. The raw MACD is an EMA gap
 * in price units, so on a $0.07 token it rounds to "+0.0" and is useless — dividing by
 * price makes the momentum comparable across assets and actually readable.
 */
export function formatMacd(tech: CmcTechnicals): string {
  if (tech.macd === undefined) return "n/a";
  const dir = tech.macd > 0 ? "bullish" : tech.macd < 0 ? "bearish" : "flat";
  const pct =
    tech.lastClose && tech.lastClose > 0
      ? (tech.macd / tech.lastClose) * 100
      : undefined;
  const mag =
    pct !== undefined
      ? `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`
      : `${tech.macd >= 0 ? "+" : ""}${tech.macd}`;
  return `${dir} (${mag})`;
}

/** EMA12-vs-EMA26 trend, or undefined when either EMA is missing. */
function emaTrend(tech: CmcTechnicals): "up" | "down" | undefined {
  if (tech.ema12 === undefined || tech.ema26 === undefined) return undefined;
  return tech.ema12 >= tech.ema26 ? "up" : "down";
}

/** A compact one-line `RSI14 83, MACD bullish (+0.3%), EMA ▲` summary for one timeframe. */
export function formatTechnicalRow(tech: CmcTechnicals): string {
  const rsi = tech.rsi14 !== undefined ? `RSI14 ${tech.rsi14.toFixed(0)}` : "RSI14 n/a";
  const trend = emaTrend(tech);
  const ema = trend ? `, EMA ${trend === "up" ? "▲" : "▼"}` : "";
  return `${rsi}, MACD ${formatMacd(tech)}${ema}`;
}

/**
 * The EXPANDED, forecast-style indicator breakdown for one timeframe — RSI (with an
 * overbought/oversold/neutral read), normalized MACD momentum, the EMA12/EMA26 cross,
 * price position vs the slow EMA, and realized volatility. Used when the user asks for a
 * single timeframe (e.g. "research SIREN on daily") so the read goes deep, not wide.
 */
export function technicalSignals(tech: CmcTechnicals, price?: number): string[] {
  const out: string[] = [];

  if (tech.rsi14 !== undefined) {
    const r = tech.rsi14;
    const tag =
      r >= 70 ? "overbought" : r <= 30 ? "oversold" : r >= 55 ? "bullish" : r <= 45 ? "bearish" : "neutral";
    out.push(`RSI14: ${r.toFixed(0)} (${tag})`);
  }

  if (tech.macd !== undefined) out.push(`MACD: ${formatMacd(tech)}`);

  const trend = emaTrend(tech);
  if (trend && tech.ema12 !== undefined && tech.ema26 !== undefined) {
    out.push(
      `EMA12 / EMA26: ${fmtPrice(tech.ema12)} / ${fmtPrice(tech.ema26)} (${trend === "up" ? "uptrend" : "downtrend"})`,
    );
  }

  const ref = price ?? tech.lastClose;
  if (ref && ref > 0 && tech.ema26 && tech.ema26 > 0) {
    const d = (ref / tech.ema26 - 1) * 100;
    out.push(`Price vs EMA26: ${d >= 0 ? "+" : ""}${d.toFixed(1)}% (${d >= 0 ? "above" : "below"})`);
  }

  if (tech.volPct !== undefined)
    out.push(`Volatility: ${(tech.volPct * 100).toFixed(1)}% avg move/candle`);

  return out;
}

/**
 * The one-line `Verdict:` summary — bias, confidence %, and target price/move — for the
 * research card. Returns undefined for a zero-confidence neutral (nothing worth showing).
 */
export function formatVerdict(verdict: ResearchVerdict, price: number): string | undefined {
  if (verdict.confidence === 0 && verdict.bias === "neutral") return undefined;
  const label = verdict.bias.charAt(0).toUpperCase() + verdict.bias.slice(1);
  const conf = `confidence ${(verdict.confidence * 100).toFixed(0)}%`;
  let target = "";
  if (verdict.targetPrice !== undefined && verdict.targetPct !== undefined) {
    const pct = `${verdict.targetPct >= 0 ? "+" : ""}${(verdict.targetPct * 100).toFixed(1)}%`;
    target = ` · target $${verdict.targetPrice.toLocaleString(undefined, {
      maximumFractionDigits: verdict.targetPrice >= 1 ? 2 : 6,
    })} (${pct})`;
  }
  return `${biasEmoji(verdict.bias)} ${label} · ${conf}${target}`;
}
