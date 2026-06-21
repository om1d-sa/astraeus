/**
 * CMC skill bundles — run a configurable list of CoinMarketCap Skill Hub skills
 * (via execute_skill) and merge their text analyses into a command's output.
 *
 * These are SLOW (each execute_skill can take tens of seconds) and return
 * qualitative "evidence pack" text (not numeric signals), so the whole layer is
 * gated by CMC_SKILLS_ENABLED (OFF by default) and each call is bounded + best-effort.
 *
 * Skill lists are overridable via env (MARKET_SKILLS / TRENDING_SKILLS / RESEARCH_SKILLS,
 * comma-separated unique_names); otherwise the DEFAULT_* lists below are used.
 *
 * Each skill has its OWN input schema (almost all `additionalProperties:false`), so the
 * runner builds schema-exact params PER SKILL via SKILL_SPECS (see skill-schemas.ts)
 * rather than passing one shared bag — that shared bag, leaking extra props into strict
 * schemas and never supplying required ones, is what made most skills fail.
 */
import { type IAgentRuntime, logger, ModelType } from "@elizaos/core";
import { McpService } from "@elizaos/plugin-mcp";
import {
  buildSkillJobs,
  type SkillCtx,
  type SkillJob,
} from "./skill-schemas";

const CMC_SERVER = "cmc-skill-hub";

type McpLike = {
  callTool(
    server: string,
    tool: string,
    args?: Record<string, unknown>,
  ): Promise<{ isError?: boolean; content?: Array<{ text?: string }> }>;
};

const num = (key: string, fallback: number): number => {
  const v = process.env[key];
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
};

function raceTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  const TIMEOUT = "__skill_timeout__" as const;
  const guard = new Promise<typeof TIMEOUT>((resolve) => {
    const t = setTimeout(() => resolve(TIMEOUT), ms);
    (t as { unref?: () => void }).unref?.();
  });
  return Promise.race([p, guard]).then((r) =>
    r === TIMEOUT ? undefined : (r as T),
  );
}

/** Whether the (slow) CMC skill bundles are enabled. OFF by default. */
export function skillsEnabled(): boolean {
  return (process.env.CMC_SKILLS_ENABLED ?? "false").toLowerCase() === "true";
}

/**
 * Whether to show the raw "CMC SKILL ANALYSES" bundle dump in user-facing replies
 * when LLM synthesis is unavailable. OFF by default — the raw dump is noisy; the
 * synthesized one-line "CMC skill read" is the intended signal. The bundle still
 * feeds the score regardless. Set CMC_SKILLS_SHOW_RAW=true to restore the dump.
 *
 * Only governs the fallback dump in forecast-style replies (MARKET/RESEARCH/
 * TRENDING); LIQUIDATION/PORTFOLIO render the bundle as their whole output and
 * are unaffected.
 */
export function showRawSkillBundle(): boolean {
  return (process.env.CMC_SKILLS_SHOW_RAW ?? "false").toLowerCase() === "true";
}

const hasContent = (v: unknown): boolean =>
  typeof v === "string"
    ? v.trim().length > 0
    : v != null && typeof v === "object"
      ? Object.keys(v as object).length > 0
      : v != null;

/**
 * True if a skill's execute_skill payload is an error rather than a usable
 * result. CMC validation/skill failures come back as a *successful* MCP response
 * whose text is a JSON error envelope (top-level `error`, or a wrapped result
 * with `success:false` / non-zero `exitCode`), so they slip past the
 * transport-level `isError` flag and would otherwise be spliced into the reply.
 */
export function isErrorPayload(txt: string): boolean {
  try {
    const j = JSON.parse(txt) as {
      error?: unknown;
      result?: { success?: boolean; exitCode?: number; error?: unknown };
    };
    if (hasContent(j.error)) return true;
    const r = j.result;
    if (r && typeof r === "object") {
      if (r.success === false) return true;
      if (typeof r.exitCode === "number" && r.exitCode !== 0) return true;
      if (hasContent(r.error)) return true;
    }
    return false;
  } catch {
    // Not JSON — fall back to known CMC error markers.
    return /INVALID_ARGUMENT|INVALID_PARAMS|validation failed|"success"\s*:\s*false/i.test(
      txt,
    );
  }
}

/** Resolve a comma-separated skill list from env, falling back to defaults. */
export function skillList(envKey: string, fallback: string[]): string[] {
  const raw = process.env[envKey]?.trim();
  return raw
    ? raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : fallback;
}


/** Flatten an execute_skill MCP response to its text payload. */
const skillResultText = (r: { content?: Array<{ text?: string }> }): string =>
  (r.content ?? [])
    .map((c) => c.text ?? "")
    .join("\n")
    .trim();

/** One-line snippet of a payload for compact debug output. */
const snippet = (s: string, max = 140): string =>
  s.replace(/\s+/g, " ").trim().slice(0, max);

/**
 * Short, human reason from a CMC error envelope (for the debug probe). Most failures are
 * `INVALID_ARGUMENT` from a schema mismatch (the bundle's shared params don't fit every
 * skill); surface just the code + the offending property so the report stays small and
 * readable instead of dumping the full JSON.
 */
function errorReason(txt: string): string {
  try {
    const j = JSON.parse(txt) as {
      error?: { code?: unknown; message?: unknown };
      result?: { error?: { code?: unknown; message?: unknown } };
    };
    const err = j.error ?? j.result?.error;
    const code = String(err?.code ?? "error");
    const msg = String(err?.message ?? "");
    const required = msg.match(/required property '([^']+)'/)?.[1];
    if (required) return `${code}: needs '${required}'`;
    const prop = msg.match(/property '([^']+)'/)?.[1];
    if (prop) return `${code}: '${prop}' not accepted`;
    return code !== "error" ? code : snippet(msg || txt, 80);
  } catch {
    return snippet(txt, 80);
  }
}

/**
 * Pull a human-readable one-liner from a CMC skill payload. CMC skills return a
 * (often double-encoded) JSON envelope whose headline lives under a different key
 * per skill type — `summary` for most, `conclusion` (e.g. the breakout scanner) or
 * `decision` for others. Extract the first concise one (skipping long `analysis` /
 * terse `title`) so replies show a clean sentence per skill instead of raw JSON.
 * Returns undefined when none is present.
 */
export function extractSkillSummary(raw: string): string | undefined {
  const tryParse = (s: string): unknown => {
    try {
      return JSON.parse(s);
    } catch {
      return undefined;
    }
  };
  // First non-empty string value for `key`, descending into objects, arrays, and
  // JSON-string fields (CMC double-encodes `output` as a JSON string).
  const findKey = (v: unknown, key: string, depth: number): string | undefined => {
    if (depth > 8 || v == null) return undefined;
    if (typeof v === "string") {
      const t = v.trim();
      return t.startsWith("{") || t.startsWith("[")
        ? findKey(tryParse(t), key, depth + 1)
        : undefined;
    }
    if (Array.isArray(v)) {
      for (const x of v) {
        const f = findKey(x, key, depth + 1);
        if (f) return f;
      }
      return undefined;
    }
    if (typeof v === "object") {
      const obj = v as Record<string, unknown>;
      if (typeof obj[key] === "string" && (obj[key] as string).trim())
        return (obj[key] as string).trim();
      for (const val of Object.values(obj)) {
        const f = findKey(val, key, depth + 1);
        if (f) return f;
      }
    }
    return undefined;
  };
  const tree = tryParse(raw) ?? raw;
  for (const key of ["summary", "conclusion", "decision"]) {
    const found = findKey(tree, key, 0);
    if (found) return found;
  }
  return undefined;
}

/** A skill bundle distilled into a directional signal + a short synthesis. */
export interface SkillSynthesis {
  /** -1 (very bearish) … +1 (very bullish). */
  sentiment: number;
  /** One or two sentences synthesizing the skill evidence. */
  summary: string;
}

/**
 * Distill a {@link runSkillBundle} text blob into a directional sentiment (-1..1) + a
 * short synthesis, via the LLM. This lets the info commands ACT on the CMC skills —
 * blend the sentiment into their score, or show a real verdict — instead of just dumping
 * the raw list. Best-effort: returns undefined on any failure (empty input, bad JSON, LLM
 * error) so the caller falls back to its base behaviour.
 */
export async function synthesizeSkillSentiment(
  runtime: IAgentRuntime,
  bundleText: string,
  context = "the crypto market",
): Promise<SkillSynthesis | undefined> {
  if (!bundleText.trim()) return undefined;
  try {
    const prompt = `You are a crypto market analyst. Below are qualitative CoinMarketCap Skill Hub analyses for ${context}. Weigh them into ONE directional read.

${bundleText}

Respond with ONLY this JSON, nothing else:
{"sentiment": <number from -1 (very bearish) to 1 (very bullish)>, "summary": "<one or two concise sentences synthesizing the key signals>"}`;
    const raw = await runtime.useModel(ModelType.TEXT_LARGE, { prompt });
    const m = String(raw).match(/\{[\s\S]*\}/);
    if (!m) return undefined;
    const parsed = JSON.parse(m[0]) as { sentiment?: unknown; summary?: unknown };
    const s = Number(parsed.sentiment);
    const sentiment = Number.isFinite(s) ? Math.max(-1, Math.min(1, s)) : 0;
    const summary =
      typeof parsed.summary === "string" ? parsed.summary.trim() : "";
    return summary ? { sentiment, summary } : undefined;
  } catch (e) {
    logger.warn({ err: String(e) }, "skill synthesis failed — using base read");
    return undefined;
  }
}

/** Translate the legacy (params, opts) call shape into a {@link SkillCtx}. */
function toCtx(
  params: Record<string, unknown>,
  opts: { symbols?: string[] },
): SkillCtx {
  const rawHoldings = (params.holdings ?? params.portfolio) as unknown;
  const holdings = Array.isArray(rawHoldings)
    ? (rawHoldings as Array<Record<string, unknown>>)
        .map((h) => ({
          symbol: String(h.symbol ?? ""),
          pct: Number(h.pct ?? h.weight_pct ?? 0),
          valueUsd:
            typeof h.valueUsd === "number" ? h.valueUsd : undefined,
        }))
        .filter((h) => h.symbol)
    : undefined;
  return {
    symbol: typeof params.symbol === "string" ? params.symbol : undefined,
    symbols: opts.symbols,
    holdings: holdings?.length ? holdings : undefined,
    contractToken:
      (params.contractToken as SkillCtx["contractToken"]) || undefined,
  };
}

/**
 * Expand a skill-name list into concrete execute_skill jobs. Delegates to
 * {@link buildSkillJobs}: each known skill gets schema-exact params from SKILL_SPECS
 * (fan skills run once per symbol); unknown names (e.g. test fixtures) fall back to the
 * legacy shared-params + per-skill merge. Shared by {@link runSkillBundle} and
 * {@link probeSkillBundle} so both build identical jobs.
 */
function buildJobs(
  uniqueNames: string[],
  params: Record<string, unknown>,
  opts: {
    symbols?: string[];
    perSkillParams?: Record<string, Record<string, unknown>>;
  },
): SkillJob[] {
  const ctx = toCtx(params, opts);
  const legacy = (name: string): Record<string, unknown> => ({
    ...params,
    ...(opts.perSkillParams?.[name] ?? {}),
  });
  return buildSkillJobs(uniqueNames, ctx, legacy);
}

/**
 * Run a bundle of CMC skills via execute_skill (parallel, each bounded, best-effort).
 * Returns a concatenated text blob, or undefined if disabled / empty / all failed.
 *
 * `opts.symbols` fans every SYMBOL_SKILLS entry across the given symbols (one call
 * each, `symbol` merged into params). `opts.perSkillParams` merges per-skill param
 * overrides on top of the shared `params` (e.g. `assets` for an ETF-comparison skill).
 */
export async function runSkillBundle(
  runtime: IAgentRuntime,
  uniqueNames: string[],
  params: Record<string, unknown> = {},
  opts: {
    force?: boolean;
    symbols?: string[];
    perSkillParams?: Record<string, Record<string, unknown>>;
  } = {},
): Promise<string | undefined> {
  // `force` lets explicit skill-driven commands (PORTFOLIO/LIQUIDATION) run even
  // when the auto-enrichment master toggle (CMC_SKILLS_ENABLED) is off.
  if ((!skillsEnabled() && !opts.force) || uniqueNames.length === 0)
    return undefined;
  const mcp = runtime.getService(
    McpService.serviceType,
  ) as unknown as McpLike | null;
  if (!mcp) return undefined;
  const timeoutMs = num("CMC_SKILLS_TIMEOUT_MS", 90_000);
  const jobs = buildJobs(uniqueNames, params, opts);

  const runOne = async (job: SkillJob): Promise<string | undefined> => {
    try {
      const exec = await raceTimeout(
        mcp.callTool(CMC_SERVER, "execute_skill", {
          unique_name: job.name,
          parameters: job.params,
        }),
        timeoutMs,
      );
      if (!exec || exec.isError) return undefined;
      const txt = skillResultText(exec);
      if (!txt) return undefined;
      // CMC returns validation/skill errors as a *successful* MCP response whose
      // payload is an error envelope — drop those so they don't pollute the reply.
      if (isErrorPayload(txt)) {
        logger.debug({ skill: job.label }, "CMC skill returned an error payload");
        return undefined;
      }
      // Show the skill's human-readable summary, not its raw (double-encoded) JSON.
      const summary = extractSkillSummary(txt);
      return `• ${job.label}: ${summary ? snippet(summary, 300) : snippet(txt, 240)}`;
    } catch (e) {
      logger.warn({ skill: job.label, err: String(e) }, "CMC skill skipped");
      return undefined;
    }
  };

  const parts = (await Promise.all(jobs.map(runOne))).filter(
    (p): p is string => Boolean(p),
  );
  return parts.length
    ? `CMC SKILL ANALYSES:\n${parts.join("\n")}`
    : undefined;
}

// ---- Default skill bundles per feature (override via env) ----
//
// Every skill below has an entry in SKILL_SPECS (skill-schemas.ts) that builds its exact
// schema params. Per-symbol skills are fanned across the majors (BTC/ETH/BNB) by the
// caller's `symbols`. Skills that fundamentally need user-specific structured input the
// feature can't supply — live options Greeks, a perp position snapshot, a trade ledger,
// fabricated unlock rows, or a down social surface — are deliberately NOT listed (they
// would only ever return INVALID_ARGUMENT / DATA_UNAVAILABLE here).

// MARKET overview is an OVERALL-MARKET read across macro, ETF, liquidity, sector and
// per-symbol perp lanes; per-symbol skills fan across BTC/ETH/BNB.
export const DEFAULT_MARKET_SKILLS = [
  "daily_market_overview",
  "btc_etf_institutional_demand",
  "macro_liquidity_monitor",
  "macro_financial_conditions",
  "macro_news_aggregator",
  "build_daily_market_brief",
  "screen_perp_accumulation_candidates",
  "detect_market_regime",
  "assess_macro_liquidity_risk_regime",
  // analyze_cross_asset_risk_regime excluded — its cross-asset (equities/gold/DXY) data
  // surface isn't derivable on this API plan, so it always returns DATA_GAPS.
  "rank_short_squeeze_fuel_candidates",
  "detect_etf_flow_price_absorption",
  "analyze_btc_eth_etf_flow_impact",
  "compare_etf_flow_quality",
  "track_narrative_rotation",
  "monitor_altcoin_season_transition",
  "compare_sector_relative_strength",
  "build_crypto_event_watchlist",
  // Per-symbol skills — fanned across BTC/ETH/BNB by the MARKET caller.
  "detect_funding_rate_regime_shift",
  "review_mean_reversion_setup",
  "detect_perp_bull_bear_divergence",
  "review_etf_flow_vs_perp_sentiment",
  "exchange_market_structure_monitor",
  "detect_perp_momentum_exhaustion",
];

// TRENDING is a discovery read — scanners + per-symbol perp structure fanned across the
// majors. Single-token/contract skills (token safety, holder concentration) need a
// specific token+contract and live in RESEARCH instead.
export const DEFAULT_TRENDING_SKILLS = [
  "altcoin_breakout_scanner_spot",
  "screen_perp_accumulation_candidates",
  "analyze_open_interest_price_divergence",
  "assess_volatility_expansion_risk",
  "monitor_whale_transfer_anomalies",
  "analyze_perp_trend_structure",
  "screen_spot_breakout_candidates",
  "track_narrative_rotation",
  "rank_perp_altcoin_anomaly_setups",
  "compare_sector_relative_strength",
  "track_exchange_inflow_outflow_pressure",
  "build_indicator_trade_watchlist",
  "detect_perp_bull_bear_divergence",
  "compare_sector_strength",
  "detect_perp_momentum_exhaustion",
];

// RESEARCH is single-token due diligence: per-symbol/per-token skills run on the
// researched asset (contract-scoped ones use the RESEARCH-resolved on-chain contract).
export const DEFAULT_RESEARCH_SKILLS = [
  "analyze_token_unlock_impact",
  "rank_liquidation_magnet_levels",
  "compare_funding_rate_across_venues",
  "build_altcoin_market_context_profile",
  "assess_altcoin_sector_relative_position",
  "analyze_multi_timeframe_trend_alignment",
  "assess_altcoin_kol_consensus_with_identity_resolution",
  "monitor_whale_transfer_anomalies",
  "compare_token_unlock_risk_bucket",
  "review_support_resistance_confluence",
  "assess_altcoin_asset_structure",
  "detect_spot_perp_flow_divergence",
  "verify_social_claim_with_market_data",
  "screen_spot_breakout_candidates",
  "score_holder_concentration_risk",
  "price_probability_forecaster",
  "rank_token_unlock_supply_pressure",
  "detect_leverage_reset_completion",
  "assess_unlock_absorption_capacity",
  "detect_holder_distribution_trend",
  "cross_asset_market_charting",
  "review_mean_reversion_setup",
  "track_social_price_divergence",
  "track_exchange_inflow_outflow_pressure",
  "detect_perp_bull_bear_divergence",
  "compare_sector_strength",
  // review_token_supply_overhang excluded — its market-evidence lane is unavailable on
  // this plan for every token tried (ETH, ARB, OP, slug); covered by the unlock skills above.
];

/** ETF-flow skills for the BTC/ETH forecast (20% leg). Not used for BNB. */
export const DEFAULT_ETF_SKILLS = [
  "btc_etf_institutional_demand",
  "compare_etf_flow_quality",
  "detect_etf_flow_price_absorption",
  "analyze_btc_eth_etf_flow_impact",
  "review_etf_flow_vs_perp_sentiment",
];

/**
 * Portfolio-risk analysis skills (PORTFOLIO_ANALYSIS feature). These all run off the
 * user's parsed spot holdings (synthesized into each skill's schema by SKILL_SPECS).
 * Options-Greek / derivatives / PnL-ledger skills are excluded — a spot %-portfolio
 * has no options positions, perp legs, or trade ledger to feed them.
 */
export const DEFAULT_PORTFOLIO_SKILLS = [
  "portfolio_analysis",
  "build_regime_aware_allocation",
  "build_rebalance_plan",
  "build_portfolio_rebalance_plan",
];

/**
 * Liquidation-cascade analysis skills (LIQUIDATION_ANALYSIS feature). Per-symbol skills
 * fan across the majors. `calculate_perp_position_liquidation_buffer` is excluded — it
 * needs a live perp position snapshot the market-wide read doesn't have.
 */
export const DEFAULT_LIQUIDATION_SKILLS = [
  "assess_liquidation_cascade_risk",
  "rank_short_squeeze_fuel_candidates",
  "detect_liquidation_cluster_risk",
  "detect_volatility_squeeze_release",
  "estimate_large_trade_liquidity_risk",
];

// ---- Skill-bundle debugging (AGENT_DEBUG) ----

/** True if the CMC Skill Hub MCP service (`cmc-skill-hub`) is wired into the runtime. */
export function mcpAvailable(runtime: IAgentRuntime): boolean {
  return !!runtime.getService(McpService.serviceType);
}

/** A skill bundle wired into a feature: its label, env-override key, default list, and
 *  the params/symbols the owning feature actually calls it with (so a debug probe is
 *  faithful — skills whose required inputs aren't satisfied error out exactly as in prod). */
export interface BundleSpec {
  feature: string;
  envKey: string;
  defaults: string[];
  params?: Record<string, unknown>;
  symbols?: string[];
  perSkillParams?: Record<string, Record<string, unknown>>;
}

/**
 * Every CMC skill bundle the agent uses, in report order. The single source of truth
 * the debug report iterates over; `skillList(envKey, defaults)` resolves the live list.
 * The params/symbols mirror each feature's real {@link runSkillBundle} call site so the
 * debug probe builds the exact same per-skill jobs as production.
 */
export const SKILL_BUNDLES: readonly BundleSpec[] = [
  {
    feature: "Overall market",
    envKey: "MARKET_SKILLS",
    defaults: DEFAULT_MARKET_SKILLS,
    symbols: ["BTC", "ETH", "BNB"],
  },
  {
    feature: "Trending cryptos",
    envKey: "TRENDING_SKILLS",
    defaults: DEFAULT_TRENDING_SKILLS,
    symbols: ["BTC", "ETH", "BNB"],
  },
  {
    feature: "Crypto research",
    envKey: "RESEARCH_SKILLS",
    defaults: DEFAULT_RESEARCH_SKILLS,
    // A liquid altcoin (perps + sector tags) is representative — altcoin-scoped skills
    // (e.g. sector relative position) can't classify a base layer like ETH.
    params: { symbol: "SOL" },
  },
  {
    feature: "Portfolio analysis",
    envKey: "PORTFOLIO_SKILLS",
    defaults: DEFAULT_PORTFOLIO_SKILLS,
    params: {
      holdings: [
        { symbol: "BTC", pct: 50 },
        { symbol: "ETH", pct: 30 },
        { symbol: "USDT", pct: 20 },
      ],
    },
  },
  {
    feature: "Liquidation analysis",
    envKey: "LIQUIDATION_SKILLS",
    defaults: DEFAULT_LIQUIDATION_SKILLS,
    symbols: ["BTC", "ETH", "BNB"],
  },
  {
    feature: "Forecast ETF leg",
    envKey: "FORECAST_ETF_SKILLS",
    defaults: DEFAULT_ETF_SKILLS,
    params: { symbol: "ETH" },
  },
];

/** Per-skill outcome from a live debug probe of a bundle. */
export interface SkillProbeResult {
  /** Job label — the unique_name, suffixed `:SYMBOL` for fanned symbol skills. */
  skill: string;
  status: "ok" | "error" | "timeout" | "empty";
  /** Payload size on success, or a short reason on failure. */
  detail: string;
  /** Wall-clock time for the execute_skill call, in ms. */
  ms: number;
}

/**
 * Live-probe a skill bundle for debugging: run each skill via execute_skill (in
 * parallel, each bounded by CMC_SKILLS_TIMEOUT_MS) and report a per-skill status —
 * ok / error / timeout / empty — instead of merging text. Unlike {@link runSkillBundle}
 * this ALWAYS runs (no CMC_SKILLS_ENABLED gate) because it's an explicit user debug
 * action; it DOES spend CMC API credits. `opts.limit` caps how many jobs are probed
 * (after symbol fan-out) so a quick check doesn't run the whole bundle. Returns []
 * when the MCP service is unavailable.
 */
export async function probeSkillBundle(
  runtime: IAgentRuntime,
  uniqueNames: string[],
  params: Record<string, unknown> = {},
  opts: {
    symbols?: string[];
    perSkillParams?: Record<string, Record<string, unknown>>;
    limit?: number;
  } = {},
): Promise<SkillProbeResult[]> {
  const mcp = runtime.getService(
    McpService.serviceType,
  ) as unknown as McpLike | null;
  if (!mcp) return [];
  const timeoutMs = num("CMC_SKILLS_TIMEOUT_MS", 90_000);
  let jobs = buildJobs(uniqueNames, params, opts);
  if (opts.limit && opts.limit > 0) jobs = jobs.slice(0, opts.limit);

  const probeOne = async (job: SkillJob): Promise<SkillProbeResult> => {
    const t0 = Date.now();
    try {
      const exec = await raceTimeout(
        mcp.callTool(CMC_SERVER, "execute_skill", {
          unique_name: job.name,
          parameters: job.params,
        }),
        timeoutMs,
      );
      const ms = Date.now() - t0;
      if (!exec)
        return {
          skill: job.label,
          status: "timeout",
          detail: `no response within ${Math.round(timeoutMs / 1000)}s`,
          ms,
        };
      if (exec.isError)
        return {
          skill: job.label,
          status: "error",
          detail: "MCP transport error (isError)",
          ms,
        };
      const txt = skillResultText(exec);
      if (!txt)
        return { skill: job.label, status: "empty", detail: "empty payload", ms };
      // CMC returns validation/skill failures as a *successful* MCP response whose
      // payload is an error envelope — surface those as errors with the reason.
      if (isErrorPayload(txt))
        return {
          skill: job.label,
          status: "error",
          detail: errorReason(txt),
          ms,
        };
      return { skill: job.label, status: "ok", detail: `${txt.length} chars`, ms };
    } catch (e) {
      return {
        skill: job.label,
        status: "error",
        detail: snippet(String(e)),
        ms: Date.now() - t0,
      };
    }
  };

  return Promise.all(jobs.map(probeOne));
}
