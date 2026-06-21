/**
 * Per-skill parameter registry for the CoinMarketCap Skill Hub.
 *
 * WHY THIS EXISTS — each Skill Hub skill has its OWN input schema, almost always with
 * `additionalProperties:false` and its own `required` fields. A single shared params
 * bag therefore fails most skills two ways at once: an extra prop (e.g. `lookback_days`
 * on a preview-only skill) is rejected, and a missing required prop (e.g. `symbol`) errors.
 * That is why "most skills failed" with INVALID_ARGUMENT.
 *
 * This registry maps every skill we run to a builder that returns EXACTLY the params its
 * schema accepts — required fields filled from schema defaults or feature context — so each
 * skill executes instead of erroring. Schemas were pulled live from the MCP server; see
 * scripts/fetch-skill-schemas.py and scripts/skill-schemas.json.
 *
 * Skills that fundamentally require user-specific structured input the calling feature can't
 * supply (live options Greeks, a perp position snapshot, a trade ledger, fabricated unlock
 * rows, or a down social-data surface) are intentionally NOT in the default bundle lists —
 * see skill-bundle.ts.
 */

/** A parsed portfolio holding (PORTFOLIO feature). */
export interface PortfolioHolding {
  symbol: string;
  pct: number;
  valueUsd?: number;
}

/** Context a feature supplies; a skill's builder reads only what it needs. */
export interface SkillCtx {
  /** Per-call asset symbol — set by the fan-out loop, or by a single-asset feature. */
  symbol?: string;
  /** Feature asset universe (the majors); fanned skills run once per entry. */
  symbols?: string[];
  /** Parsed portfolio holdings (PORTFOLIO feature). */
  holdings?: PortfolioHolding[];
  /** Resolved on-chain token for contract-scoped skills (RESEARCH resolves this). */
  contractToken?: { symbol: string; platform: string; contract: string };
}

export interface SkillSpec {
  /** Build the exact params object for ONE execution. */
  build: (c: SkillCtx) => Record<string, unknown>;
  /** When true the skill runs once per `ctx.symbols` entry (current symbol in `c.symbol`). */
  fan?: boolean;
  /**
   * Optional filter narrowing which universe symbols a fan skill applies to — e.g. the
   * ETF-vs-perp skill only has ETF history for BTC/ETH, so fanning it across BNB just
   * returns a data gap. Returning [] means the skill isn't applicable to this universe.
   */
  fanSymbols?: (syms: string[]) => string[];
}

/** Default base asset when a symbol-scoped skill has no symbol/universe to fan over. */
export const DEFAULT_SYMBOL = "BTC";

/** Coherent on-chain default for contract-scoped skills when no token is resolved (AAVE/ETH). */
const DEFAULT_TOKEN = {
  symbol: "AAVE",
  platform: "ethereum",
  contract: "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9",
};

/** Assumed portfolio notional used to turn weight percentages into USD position values. */
const NOTIONAL_USD = 100_000;

const sym = (c: SkillCtx): string => c.symbol ?? DEFAULT_SYMBOL;
const tok = (c: SkillCtx) => c.contractToken ?? DEFAULT_TOKEN;
const isBtcEth = (s?: string): boolean => s === "BTC" || s === "ETH";

/** preview-only trigger (`{ preview: true }`). */
const PREVIEW: SkillSpec = { build: () => ({ preview: true }) };
/** no required params — rely on the skill's own server-side defaults. */
const NONE: SkillSpec = { build: () => ({}) };
/** required: just `symbol`, fanned across the feature's assets. */
const SYMBOL: SkillSpec = { fan: true, build: (c) => ({ symbol: sym(c) }) };
/** required: just `token_id_or_symbol`, fanned across the feature's assets. */
const TOKEN_SYMBOL: SkillSpec = { fan: true, build: (c) => ({ token_id_or_symbol: sym(c) }) };

function riskBucket(symbol: string): "high_beta" | "core" | "defensive" {
  const s = symbol.toUpperCase();
  if (/^(USDT|USDC|DAI|TUSD|BUSD|FDUSD|USDE|PYUSD)$/.test(s)) return "defensive";
  if (s === "BTC" || s === "ETH") return "core";
  return "high_beta";
}

function holdingsOf(c: SkillCtx): PortfolioHolding[] {
  return c.holdings?.length
    ? c.holdings
    : [
        { symbol: "BTC", pct: 50 },
        { symbol: "ETH", pct: 50 },
      ];
}
const valueOf = (h: PortfolioHolding): number => h.valueUsd ?? (h.pct / 100) * NOTIONAL_USD;

/** current weights normalized to fractions summing to ~1. */
function targetWeights(hs: PortfolioHolding[]): Array<{ asset: string; target_weight: number }> {
  const total = hs.reduce((s, h) => s + h.pct, 0) || 1;
  return hs.map((h) => ({ asset: h.symbol, target_weight: h.pct / total }));
}

/**
 * The single source of truth for skill parameters. Any skill referenced by a default
 * bundle list MUST have an entry here; unknown skills fall back to legacy shared-params
 * behaviour in skill-bundle.ts.
 */
export const SKILL_SPECS: Record<string, SkillSpec> = {
  // ---- preview-only triggers ----
  daily_market_overview: PREVIEW,
  macro_liquidity_monitor: PREVIEW,
  btc_etf_institutional_demand: PREVIEW,
  macro_news_aggregator: PREVIEW,
  altcoin_breakout_scanner_spot: PREVIEW,

  // ---- no required params (server defaults apply) ----
  detect_market_regime: NONE,
  build_daily_market_brief: NONE,
  assess_macro_liquidity_risk_regime: NONE,
  analyze_cross_asset_risk_regime: NONE,
  compare_sector_relative_strength: NONE,
  compare_sector_strength: NONE,
  track_narrative_rotation: NONE,
  monitor_altcoin_season_transition: NONE,
  screen_perp_accumulation_candidates: NONE,
  screen_spot_breakout_candidates: NONE,
  // needs an explicit universe + timeframe — an empty {} fails its market-data fetch.
  build_indicator_trade_watchlist: {
    build: () => ({ universe: ["BTC", "ETH", "SOL", "LINK", "AVAX", "DOGE", "ADA"], timeframe: "4h" }),
  },
  monitor_whale_transfer_anomalies: NONE,
  track_exchange_inflow_outflow_pressure: NONE,
  rank_short_squeeze_fuel_candidates: NONE,
  build_crypto_event_watchlist: NONE,
  rank_perp_altcoin_anomaly_setups: { build: () => ({ top_n: 5 }) },
  // asset must be BTC/ETH — only set it when the feature's symbol is a major.
  analyze_btc_eth_etf_flow_impact: { build: (c) => (isBtcEth(c.symbol) ? { asset: c.symbol } : {}) },
  detect_etf_flow_price_absorption: { build: (c) => (isBtcEth(c.symbol) ? { asset: c.symbol } : {}) },
  // optional symbol — run once, pinned to the symbol when one is in context.
  assess_volatility_expansion_risk: { build: (c) => (c.symbol ? { symbol: c.symbol } : {}) },
  assess_liquidation_cascade_risk: { build: (c) => (c.symbol ? { symbol: c.symbol } : {}) },

  // ---- required scalars filled from schema defaults / context ----
  macro_financial_conditions: { build: () => ({ lookback_days: 30 }) },
  compare_etf_flow_quality: { build: () => ({ assets: ["BTC", "ETH"] }) },
  compare_token_unlock_risk_bucket: { build: () => ({ tokens: ["GT", "RENDER", "DODO"], horizon: "90d" }) },
  cross_asset_market_charting: {
    build: (c) => {
      const base = sym(c);
      // quote_assets items are OBJECTS ({symbol}), not bare strings.
      const quote = ["BTC", "ETH", "SOL"].filter((a) => a !== base).slice(0, 2).map((symbol) => ({ symbol }));
      return { base_asset: base, quote_assets: quote };
    },
  },
  // verified live: this request_class fetches real unlock-pressure evidence.
  rank_token_unlock_supply_pressure: {
    build: () => ({ request_class: "rank_token_unlock_supply_pressure", live_fetch: true }),
  },

  // ---- per-symbol perp / derivatives / structure (FAN across the universe) ----
  detect_funding_rate_regime_shift: SYMBOL,
  review_mean_reversion_setup: SYMBOL,
  detect_perp_bull_bear_divergence: SYMBOL,
  // ETF history exists only for BTC/ETH — don't fan this onto other majors.
  review_etf_flow_vs_perp_sentiment: {
    fan: true,
    fanSymbols: (s) => s.filter((x) => x === "BTC" || x === "ETH"),
    build: (c) => ({ symbol: sym(c) }),
  },
  exchange_market_structure_monitor: SYMBOL,
  detect_perp_momentum_exhaustion: SYMBOL,
  analyze_perp_trend_structure: SYMBOL,
  analyze_open_interest_price_divergence: SYMBOL,
  compare_funding_rate_across_venues: SYMBOL,
  detect_leverage_reset_completion: SYMBOL,
  // its liquidation-heatmap evidence lane needs an explicit venue; window must be Nd (≥2d).
  detect_liquidation_cluster_risk: { fan: true, build: (c) => ({ symbol: sym(c), venue: "Binance", window: "7d" }) },
  detect_spot_perp_flow_divergence: SYMBOL,
  rank_liquidation_magnet_levels: SYMBOL,
  assess_altcoin_sector_relative_position: SYMBOL,
  build_altcoin_market_context_profile: SYMBOL,
  assess_altcoin_kol_consensus_with_identity_resolution: SYMBOL,
  price_probability_forecaster: { fan: true, build: (c) => ({ symbol: sym(c), horizon_days: 7 }) },

  // ---- per-token (token_id_or_symbol) (FAN across the universe) ----
  analyze_multi_timeframe_trend_alignment: TOKEN_SYMBOL,
  analyze_token_unlock_impact: TOKEN_SYMBOL,
  assess_unlock_absorption_capacity: TOKEN_SYMBOL,
  review_support_resistance_confluence: TOKEN_SYMBOL,
  review_token_supply_overhang: TOKEN_SYMBOL,
  detect_volatility_squeeze_release: TOKEN_SYMBOL,

  // ---- contract-scoped (coherent token; RESEARCH resolves the real contract) ----
  verify_new_token_safety: {
    build: (c) => ({ token_id_or_symbol: tok(c).symbol, platform: tok(c).platform, contract_address: tok(c).contract }),
  },
  score_holder_concentration_risk: {
    build: (c) => ({ token_id_or_symbol: tok(c).symbol, platform: tok(c).platform, contract_address: tok(c).contract }),
  },
  assess_altcoin_asset_structure: {
    build: (c) => ({ token_id_or_symbol: tok(c).symbol, platform: tok(c).platform, contract_address: tok(c).contract }),
  },
  detect_holder_distribution_trend: {
    build: (c) => ({ token_id_or_symbol: tok(c).symbol, platform: tok(c).platform, token_address: tok(c).contract }),
  },
  estimate_large_trade_liquidity_risk: {
    build: (c) => ({
      token_id_or_symbol: tok(c).symbol,
      platform: tok(c).platform,
      token_address: tok(c).contract,
      dex_slug: "uniswap-v3",
      notional_usd: 1_000_000,
    }),
  },

  // ---- social (best-effort; the X/social surface can be transiently unavailable) ----
  track_social_price_divergence: { build: (c) => ({ query: sym(c), symbol: sym(c) }) },
  verify_social_claim_with_market_data: {
    build: (c) => ({ claim: `${sym(c)} is seeing notable market activity`, symbol: sym(c) }),
  },

  // ---- portfolio (synthesized from the user's holdings) ----
  portfolio_analysis: {
    build: (c) => ({
      holdings: holdingsOf(c).map((h) => ({ symbol: h.symbol, position_value_usd: valueOf(h), weight_pct: h.pct })),
    }),
  },
  build_regime_aware_allocation: {
    build: (c) => ({
      current_allocation: holdingsOf(c).map((h) => ({
        asset: h.symbol,
        value_usd: valueOf(h),
        risk_bucket: riskBucket(h.symbol),
      })),
      constraints: { max_single_asset_pct: 40 },
      risk_budget: { defensive_bias: 0.5 },
    }),
  },
  build_rebalance_plan: {
    build: (c) => {
      const hs = holdingsOf(c);
      return {
        current_holdings: hs.map((h) => ({ asset: h.symbol, value_usd: valueOf(h) })),
        target_weights: targetWeights(hs),
        constraints: { weight_tolerance_pct: 5 },
      };
    },
  },
  build_portfolio_rebalance_plan: {
    build: (c) => {
      const hs = holdingsOf(c);
      return {
        current_holdings: hs.map((h) => ({ asset: h.symbol, value_usd: valueOf(h) })),
        target_weights: targetWeights(hs),
        constraints: { weight_tolerance_pct: 5 },
      };
    },
  },
};

/** A single execute_skill job (unique_name + display label + exact params). */
export interface SkillJob {
  name: string;
  label: string;
  params: Record<string, unknown>;
}

/**
 * Expand a flat skill-name list into concrete execute_skill jobs using {@link SKILL_SPECS}:
 * `fan` skills run once per `ctx.symbols` entry (or the single `ctx.symbol`, or DEFAULT_SYMBOL);
 * everything else runs once with its schema-exact params. Unknown skills (e.g. test fixtures)
 * fall back to `legacy(name)` so callers keep their prior behaviour.
 */
export function buildSkillJobs(
  uniqueNames: string[],
  ctx: SkillCtx,
  legacy: (name: string) => Record<string, unknown>,
): SkillJob[] {
  const jobs: SkillJob[] = [];
  for (const name of uniqueNames) {
    const spec = SKILL_SPECS[name];
    if (!spec) {
      jobs.push({ name, label: name, params: legacy(name) });
      continue;
    }
    if (spec.fan) {
      let syms = ctx.symbols?.length ? ctx.symbols : ctx.symbol ? [ctx.symbol] : [DEFAULT_SYMBOL];
      if (spec.fanSymbols) syms = spec.fanSymbols(syms);
      for (const s of syms) jobs.push({ name, label: `${name}:${s}`, params: spec.build({ ...ctx, symbol: s }) });
    } else {
      jobs.push({ name, label: name, params: spec.build(ctx) });
    }
  }
  return jobs;
}
