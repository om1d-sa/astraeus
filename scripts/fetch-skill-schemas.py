#!/usr/bin/env python3
"""Pull the real input_schema for every CMC Skill Hub skill used across all bundles.

find_skill is a search tool, so we query it once per unique_name (name -> words),
top_k high, and accumulate every candidate's inputSchema into one map. Then we
report, per target skill: required fields, allowed property names, and whether it
forbids extra props (additionalProperties:false) — exactly what we need to build
correct per-skill params.
"""
import json, sys, time, urllib.request, urllib.error

URL = "https://mcp.coinmarketcap.com/skill-hub/stream"
KEY = "0f0e0210a368485ab81b0fa2119c6f43"

# Union of every skill across all 6 bundles (from skill-bundle.ts).
TARGETS = sorted(set([
    # MARKET
    "daily_market_overview","btc_etf_institutional_demand","macro_liquidity_monitor",
    "macro_financial_conditions","macro_news_aggregator","build_daily_market_brief",
    "screen_perp_accumulation_candidates","detect_market_regime",
    "assess_macro_liquidity_risk_regime","analyze_cross_asset_risk_regime",
    "rank_short_squeeze_fuel_candidates","detect_etf_flow_price_absorption",
    "analyze_btc_eth_etf_flow_impact","compare_etf_flow_quality","track_narrative_rotation",
    "monitor_altcoin_season_transition","compare_sector_relative_strength",
    "build_crypto_event_watchlist","detect_funding_rate_regime_shift",
    "review_mean_reversion_setup","detect_perp_bull_bear_divergence",
    "review_etf_flow_vs_perp_sentiment","exchange_market_structure_monitor",
    "detect_perp_momentum_exhaustion",
    # TRENDING
    "altcoin_breakout_scanner_spot","analyze_open_interest_price_divergence",
    "verify_new_token_safety","assess_volatility_expansion_risk",
    "monitor_whale_transfer_anomalies","calculate_atr_trade_risk_levels",
    "design_atr_based_trade_risk_plan","analyze_perp_trend_structure",
    "screen_spot_breakout_candidates","score_holder_concentration_risk",
    "rank_perp_altcoin_anomaly_setups","track_exchange_inflow_outflow_pressure",
    "build_indicator_trade_watchlist","compare_sector_strength",
    "summarize_x_social_market_signals","token_holder_and_dex_flow_monitor",
    "token_unlock_pressure_monitor","review_token_supply_overhang",
    # RESEARCH
    "analyze_token_unlock_impact","rank_liquidation_magnet_levels",
    "compare_funding_rate_across_venues","build_altcoin_market_context_profile",
    "assess_altcoin_sector_relative_position","analyze_multi_timeframe_trend_alignment",
    "monitor_perp_position_risk","assess_altcoin_kol_consensus_with_identity_resolution",
    "compare_token_unlock_risk_bucket","assess_token_holder_dex_flow_quality",
    "review_support_resistance_confluence","assess_altcoin_asset_structure",
    "detect_spot_perp_flow_divergence","verify_social_claim_with_market_data",
    "price_probability_forecaster","rank_token_unlock_supply_pressure",
    "detect_leverage_reset_completion","assess_unlock_absorption_capacity",
    "detect_holder_distribution_trend","assess_pullback_entry_quality",
    "cross_asset_market_charting","track_social_price_divergence",
    # ETF
    # (covered above)
    # PORTFOLIO
    "build_rebalance_plan","build_portfolio_rebalance_plan","build_derivatives_risk_memo",
    "aggregate_options_portfolio_greek_exposure","review_options_portfolio_greeks",
    "rank_portfolio_pnl_driver_buckets","build_options_rollover_plan",
    # LIQUIDATION
    "calculate_perp_position_liquidation_buffer","assess_liquidation_cascade_risk",
    "detect_liquidation_cluster_risk","detect_volatility_squeeze_release",
    "estimate_large_trade_liquidity_risk",
]))

def call(method, params, _id):
    body = json.dumps({"jsonrpc":"2.0","id":_id,"method":method,"params":params}).encode()
    req = urllib.request.Request(URL, data=body, headers={
        "Content-Type":"application/json",
        "Accept":"application/json, text/event-stream",
        "X-CMC-MCP-API-KEY":KEY,
    })
    raw = urllib.request.urlopen(req, timeout=60).read().decode("utf-8","replace")
    # SSE: pull the data: line(s)
    for line in raw.splitlines():
        if line.startswith("data:"):
            return json.loads(line[5:].strip())
    return json.loads(raw)

schemas = {}      # uniqueName -> inputSchema
seen_extra = {}   # other (non-target) skills discovered, for awareness

def harvest(query, _id):
    try:
        r = call("tools/call", {"name":"find_skill","arguments":{"query":query,"top_k":15}}, _id)
        txt = r["result"]["content"][0]["text"]
        cands = json.loads(txt)["candidates"]
    except Exception as e:
        sys.stderr.write(f"  ! {query!r}: {e}\n"); return
    for c in cands:
        un = c.get("uniqueName"); sc = c.get("inputSchema")
        if not un or sc is None: continue
        if un not in schemas:
            schemas[un] = sc
        if un not in TARGETS:
            seen_extra[un] = sc

_id = 100
for name in TARGETS:
    if name in schemas:
        continue
    harvest(name.replace("_"," "), _id); _id += 1
    time.sleep(0.15)

# Second pass for any still-missing: query the raw name.
for name in TARGETS:
    if name in schemas:
        continue
    harvest(name, _id); _id += 1
    time.sleep(0.15)

out = {"schemas":schemas, "extra":sorted(seen_extra)}
with open("scripts/skill-schemas.json","w",encoding="utf-8") as f:
    json.dump(out, f, indent=2)

found = [n for n in TARGETS if n in schemas]
missing = [n for n in TARGETS if n not in schemas]
print(f"TARGETS={len(TARGETS)}  FOUND={len(found)}  MISSING={len(missing)}\n")
for n in found:
    sc = schemas[n]
    props = sc.get("properties",{}) or {}
    req = sc.get("required",[]) or []
    ap = sc.get("additionalProperties", True)
    # show enum/const constraints that matter (e.g. preview:true)
    cons = []
    for p,pd in props.items():
        if isinstance(pd,dict):
            if "const" in pd: cons.append(f"{p}={pd['const']!r}")
            elif "enum" in pd: cons.append(f"{p} in {pd['enum']}")
    print(f"{n}")
    print(f"    required : {req}")
    print(f"    props    : {list(props)}")
    print(f"    addlProps: {ap}   constraints: {cons}")
print("\nMISSING:", missing)
print("EXTRA (discovered, not in our bundles):", sorted(seen_extra))
