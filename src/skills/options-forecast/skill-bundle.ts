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
 * NOTE: each skill has its own input schema. The runner passes one shared `params`
 * object; skills whose required inputs aren't satisfied simply error and are skipped.
 */
import { type IAgentRuntime, logger } from "@elizaos/core";
import { McpService } from "@elizaos/plugin-mcp";

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

/**
 * Run a bundle of CMC skills via execute_skill (parallel, each bounded, best-effort).
 * Returns a concatenated text blob, or undefined if disabled / empty / all failed.
 */
export async function runSkillBundle(
  runtime: IAgentRuntime,
  uniqueNames: string[],
  params: Record<string, unknown> = {},
  opts: { force?: boolean } = {},
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
  const toText = (r: { content?: Array<{ text?: string }> }) =>
    (r.content ?? [])
      .map((c) => c.text ?? "")
      .join("\n")
      .trim();

  const runOne = async (name: string): Promise<string | undefined> => {
    try {
      const exec = await raceTimeout(
        mcp.callTool(CMC_SERVER, "execute_skill", {
          unique_name: name,
          parameters: params,
        }),
        timeoutMs,
      );
      if (!exec || exec.isError) return undefined;
      const txt = toText(exec);
      return txt ? `[${name}]\n${txt.slice(0, 1000)}` : undefined;
    } catch (e) {
      logger.warn({ skill: name, err: String(e) }, "CMC skill skipped");
      return undefined;
    }
  };

  const parts = (await Promise.all(uniqueNames.map(runOne))).filter(
    (p): p is string => Boolean(p),
  );
  return parts.length
    ? `CMC SKILL ANALYSES:\n${parts.join("\n---\n")}`
    : undefined;
}

// ---- Default skill bundles per feature (override via env) ----

export const DEFAULT_MARKET_SKILLS = [
  "daily_market_overview",
  "btc_etf_institutional_demand",
  "macro_liquidity_monitor",
  "macro_financial_conditions",
  "macro_news_aggregator",
  "detect_funding_rate_regime_shift",
  "build_daily_market_brief",
  "decode_macro_event_impact",
  "screen_perp_accumulation_candidates",
  "detect_market_regime",
  "detect_event_social_propagation_risk",
  "assess_macro_liquidity_risk_regime",
  "analyze_cross_asset_risk_regime",
  "rank_institutional_treasury_flow_signals",
  "rank_short_squeeze_fuel_candidates",
  "compare_etf_flow_quality",
  "detect_etf_flow_price_absorption",
  "analyze_btc_eth_etf_flow_impact",
  "build_regime_aware_allocation",
  "track_narrative_rotation",
  "monitor_altcoin_season_transition",
  "institutional_treasury_flow_monitor",
  "compare_sector_relative_strength",
  "review_mean_reversion_setup",
  "detect_perp_bull_bear_divergence",
  "review_etf_flow_vs_perp_sentiment",
  "exchange_market_structure_monitor",
  "detect_perp_momentum_exhaustion",
  "build_crypto_event_watchlist",
];

export const DEFAULT_TRENDING_SKILLS = [
  "altcoin_breakout_scanner_spot",
  "screen_perp_accumulation_candidates",
  "analyze_open_interest_price_divergence",
  "verify_new_token_safety",
  "assess_volatility_expansion_risk",
  "monitor_whale_transfer_anomalies",
  "calculate_atr_trade_risk_levels",
  "design_atr_based_trade_risk_plan",
  "analyze_perp_trend_structure",
  "screen_spot_breakout_candidates",
  "score_holder_concentration_risk",
  "track_narrative_rotation",
  "rank_perp_altcoin_anomaly_setups",
  "compare_sector_relative_strength",
  "track_exchange_inflow_outflow_pressure",
  "build_indicator_trade_watchlist",
  "detect_perp_bull_bear_divergence",
  "compare_sector_strength",
  "summarize_x_social_market_signals",
  "token_holder_and_dex_flow_monitor",
  "detect_perp_momentum_exhaustion",
  "token_unlock_pressure_monitor",
  "review_token_supply_overhang",
];

export const DEFAULT_RESEARCH_SKILLS = [
  "analyze_token_unlock_impact",
  "rank_liquidation_magnet_levels",
  "compare_funding_rate_across_venues",
  "build_altcoin_market_context_profile",
  "assess_altcoin_sector_relative_position",
  "analyze_multi_timeframe_trend_alignment",
  "monitor_perp_position_risk",
  "assess_altcoin_kol_consensus_with_identity_resolution",
  "monitor_whale_transfer_anomalies",
  "compare_token_unlock_risk_bucket",
  "assess_token_holder_dex_flow_quality",
  "review_support_resistance_confluence",
  "calculate_atr_trade_risk_levels",
  "design_atr_based_trade_risk_plan",
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
  "assess_pullback_entry_quality",
  "cross_asset_market_charting",
  "review_mean_reversion_setup",
  "track_social_price_divergence",
  "track_exchange_inflow_outflow_pressure",
  "detect_perp_bull_bear_divergence",
  "compare_sector_strength",
  "summarize_x_social_market_signals",
  "token_holder_and_dex_flow_monitor",
  "detect_perp_momentum_exhaustion",
  "token_unlock_pressure_monitor",
  "review_token_supply_overhang",
];

/** ETF-flow skills for the BTC/ETH forecast (20% leg). Not used for BNB. */
export const DEFAULT_ETF_SKILLS = [
  "btc_etf_institutional_demand",
  "compare_etf_flow_quality",
  "detect_etf_flow_price_absorption",
  "analyze_btc_eth_etf_flow_impact",
  "review_etf_flow_vs_perp_sentiment",
];

/** Portfolio-risk analysis skills (PORTFOLIO_ANALYSIS feature). */
export const DEFAULT_PORTFOLIO_SKILLS = [
  "build_rebalance_plan",
  "build_portfolio_rebalance_plan",
  "build_derivatives_risk_memo",
  "aggregate_options_portfolio_greek_exposure",
  "review_options_portfolio_greeks",
  "rank_portfolio_pnl_driver_buckets",
  "build_options_rollover_plan",
];

/** Liquidation-cascade analysis skills (LIQUIDATION_ANALYSIS feature). */
export const DEFAULT_LIQUIDATION_SKILLS = [
  "calculate_perp_position_liquidation_buffer",
  "assess_liquidation_cascade_risk",
  "rank_short_squeeze_fuel_candidates",
  "detect_liquidation_cluster_risk",
  "detect_volatility_squeeze_release",
  "estimate_large_trade_liquidity_risk",
];
