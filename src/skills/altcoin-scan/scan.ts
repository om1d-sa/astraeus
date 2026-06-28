/**
 * Track 1 — high-risk altcoin trades (the "altcoin scan").
 *
 * When TRACK1_ALTCOIN_TRADES_ENABLED is on and the ETH forecast comes back BULLISH
 * (up) or SIDEWAYS, the agent diverts that cycle: instead of the normal ETH decision
 * (the base loop buys ETH on a confident UP and skips on sideways), it REPLACES that
 * with an altcoin hunt — searching the trending feed (already filtered to the eligible
 * BSC watchlist) and researching the top candidates one by one. The FIRST candidate whose
 * deterministic research read is BULLISH with confidence ≥ TRACK1_ALTCOIN_MIN_CONFIDENCE
 * is bought. If none of the top {@link altcoinScanDepth} qualify, the cycle opens nothing
 * and the loop retries after {@link altcoinRetryMs} (default 1h).
 *
 * This module is the PURE core: env-config readers, the divert predicate, and the
 * candidate-selection logic — no network, no LLM, fully deterministic and unit-testable.
 * The TradingService wires it to live CMC research + the executor.
 */
import type { Timeframe } from "../../data/cmc";
import type { Bias } from "../research/timeframes";

/** A trending token that has already been researched (deterministic verdict attached). */
export interface AltcoinCandidate {
  symbol: string;
  /** Live price (USD) at research time — used to size the buy and the auto-close. */
  priceUsd: number;
  /** Research bias from the multi/single-timeframe verdict. */
  bias: Bias;
  /** Research confidence, 0..1 (same scale as ForecastTradeResult.confidence). */
  confidence: number;
  /** Resolved BSC contract address, when CMC could map the symbol (for TWAK live swaps). */
  address?: string;
}

const num = (key: string, fallback: number): number => {
  const v = process.env[key];
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
};

const clampInt = (n: number, lo: number, hi: number): number =>
  Math.min(Math.max(Math.trunc(n), lo), hi);

/** TRACK1_ALTCOIN_TRADES_ENABLED — master toggle (opt-in; only the literal "true" enables it). */
export function altcoinTradesEnabled(): boolean {
  return (
    (process.env.TRACK1_ALTCOIN_TRADES_ENABLED ?? "").trim().toLowerCase() ===
    "true"
  );
}

/** TRACK1_ALTCOIN_SCAN_DEPTH — how many top trending tokens to research before giving up. Default 5, clamped 1–50. */
export function altcoinScanDepth(): number {
  return clampInt(num("TRACK1_ALTCOIN_SCAN_DEPTH", 5), 1, 50);
}

/** TRACK1_ALTCOIN_MIN_CONFIDENCE — minimum bullish research confidence (%) to buy. Default 60, clamped 0–100. */
export function altcoinMinConfidencePct(): number {
  return clampInt(num("TRACK1_ALTCOIN_MIN_CONFIDENCE", 60), 0, 100);
}

/** TRACK1_ALTCOIN_RETRY_MS — how long to wait before scanning again when none of the
 *  top N qualify ("try again later"). Default 3600000 (1h), floored at 60s. */
export function altcoinRetryMs(): number {
  return Math.max(60_000, num("TRACK1_ALTCOIN_RETRY_MS", 3_600_000));
}

const TF_ALIASES: Record<string, Timeframe> = {
  "1h": "1h",
  hourly: "1h",
  "1hr": "1h",
  "4h": "4h",
  "4hr": "4h",
  fourhourly: "4h",
  "1d": "1D",
  daily: "1D",
  day: "1D",
  "1w": "1W",
  weekly: "1W",
  week: "1W",
};

/**
 * TRACK1_ALTCOIN_RESEARCH_TIMEFRAME — which chart timeframe the per-candidate research
 * read uses ("the further timeline"). Default "1h" (1 hour). Accepts 1h/4h/daily/weekly
 * aliases; anything unrecognized falls back to 1h.
 */
export function altcoinResearchTimeframe(): Timeframe {
  const raw = (process.env.TRACK1_ALTCOIN_RESEARCH_TIMEFRAME ?? "1h")
    .trim()
    .toLowerCase();
  return TF_ALIASES[raw] ?? "1h";
}

/** TRACK1_ALTCOIN_USE_CONTRACT — pass the resolved BSC contract address to TWAK instead of
 *  the (chain-ambiguous) ticker for altcoin swaps. Default ON; set "false" to use symbols. */
export function altcoinUseContract(): boolean {
  return (
    (process.env.TRACK1_ALTCOIN_USE_CONTRACT ?? "true").trim().toLowerCase() !==
    "false"
  );
}

/**
 * Whether an ETH forecast direction should DIVERT this cycle to the altcoin scan instead
 * of the normal ETH decision: true for "up" (bullish) and "sideways", false for "down".
 * Mirrors the user's rule — on bullish/sideways the agent hunts altcoins rather than ETH.
 */
export function shouldDivertToAltcoins(
  direction: "up" | "down" | "sideways" | undefined,
): boolean {
  return direction === "up" || direction === "sideways";
}

/** A candidate qualifies for a buy when its research is bullish AND confident enough. */
export function altcoinQualifies(
  c: AltcoinCandidate,
  minConfidencePct: number,
): boolean {
  return (
    c.bias === "bullish" &&
    c.priceUsd > 0 &&
    c.confidence * 100 >= minConfidencePct
  );
}

/**
 * Pick the FIRST candidate (in trending order, scanning at most `depth`) that qualifies —
 * bullish with confidence ≥ `minConfidencePct`. Returns undefined when none in the window
 * qualify (→ the caller opens nothing and retries later). Pure + deterministic.
 */
export function pickBullishAltcoin(
  candidates: AltcoinCandidate[],
  opts: { minConfidencePct: number; depth: number },
): AltcoinCandidate | undefined {
  const window = candidates.slice(0, Math.max(0, opts.depth));
  return window.find((c) => altcoinQualifies(c, opts.minConfidencePct));
}
