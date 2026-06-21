#!/usr/bin/env python3
"""Compact digest of each target skill's schema: required fields, all props with
type/default/enum, and nested required for object/array props. Authoring aid."""
import json

data = json.load(open("scripts/skill-schemas.json", encoding="utf-8"))
schemas = data["schemas"]

# Every unique skill across the 6 default bundle lists.
TARGETS = sorted(set("""
daily_market_overview btc_etf_institutional_demand macro_liquidity_monitor
macro_financial_conditions macro_news_aggregator build_daily_market_brief
screen_perp_accumulation_candidates detect_market_regime assess_macro_liquidity_risk_regime
analyze_cross_asset_risk_regime rank_short_squeeze_fuel_candidates detect_etf_flow_price_absorption
analyze_btc_eth_etf_flow_impact compare_etf_flow_quality track_narrative_rotation
monitor_altcoin_season_transition compare_sector_relative_strength build_crypto_event_watchlist
detect_funding_rate_regime_shift review_mean_reversion_setup detect_perp_bull_bear_divergence
review_etf_flow_vs_perp_sentiment exchange_market_structure_monitor detect_perp_momentum_exhaustion
altcoin_breakout_scanner_spot analyze_open_interest_price_divergence verify_new_token_safety
assess_volatility_expansion_risk monitor_whale_transfer_anomalies calculate_atr_trade_risk_levels
design_atr_based_trade_risk_plan analyze_perp_trend_structure screen_spot_breakout_candidates
score_holder_concentration_risk rank_perp_altcoin_anomaly_setups track_exchange_inflow_outflow_pressure
build_indicator_trade_watchlist compare_sector_strength summarize_x_social_market_signals
token_holder_and_dex_flow_monitor token_unlock_pressure_monitor review_token_supply_overhang
analyze_token_unlock_impact rank_liquidation_magnet_levels compare_funding_rate_across_venues
build_altcoin_market_context_profile assess_altcoin_sector_relative_position
analyze_multi_timeframe_trend_alignment monitor_perp_position_risk
assess_altcoin_kol_consensus_with_identity_resolution compare_token_unlock_risk_bucket
assess_token_holder_dex_flow_quality review_support_resistance_confluence assess_altcoin_asset_structure
detect_spot_perp_flow_divergence verify_social_claim_with_market_data price_probability_forecaster
rank_token_unlock_supply_pressure detect_leverage_reset_completion assess_unlock_absorption_capacity
detect_holder_distribution_trend assess_pullback_entry_quality cross_asset_market_charting
track_social_price_divergence build_rebalance_plan build_portfolio_rebalance_plan
build_derivatives_risk_memo aggregate_options_portfolio_greek_exposure review_options_portfolio_greeks
rank_portfolio_pnl_driver_buckets build_options_rollover_plan
calculate_perp_position_liquidation_buffer assess_liquidation_cascade_risk
detect_liquidation_cluster_risk detect_volatility_squeeze_release estimate_large_trade_liquidity_risk
""".split()))

def desc_prop(name, pd):
    if not isinstance(pd, dict): return f"{name}: ?"
    t = pd.get("type","?")
    bits = [str(t)]
    if "const" in pd: bits.append(f"const={pd['const']!r}")
    if "enum" in pd: bits.append(f"enum={pd['enum']}")
    if "default" in pd: bits.append(f"default={pd['default']!r}")
    if t == "object":
        sub = pd.get("properties",{})
        if sub:
            bits.append(f"objreq={pd.get('required',[])} objprops={list(sub)}")
    if t == "array":
        it = pd.get("items",{})
        if isinstance(it, dict) and it.get("type")=="object":
            bits.append(f"itemreq={it.get('required',[])} itemprops={list(it.get('properties',{}))}")
        elif isinstance(it, dict) and "enum" in it:
            bits.append(f"itemenum={it['enum']}")
    return f"{name}: " + " ".join(bits)

for n in TARGETS:
    sc = schemas.get(n)
    if not sc:
        print(f"### {n}  (NOT FOUND)\n"); continue
    req = sc.get("required",[])
    oneOf = sc.get("oneOf") or sc.get("anyOf")
    ap = sc.get("additionalProperties", True)
    print(f"### {n}   required={req}  addlProps={ap}" + (f"  anyOf/oneOf={[o.get('required') for o in oneOf]}" if oneOf else ""))
    for pn, pd in (sc.get("properties") or {}).items():
        print("    - " + desc_prop(pn, pd))
    print()
