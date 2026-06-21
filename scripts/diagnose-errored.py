#!/usr/bin/env python3
"""Diagnose each errored skill: is it fixable with better params/scope, or an inherent
data/scope limit? Re-run each with (a) our current params and (b) enriched params or a
properly-scoped symbol, and compare."""
import json, urllib.request, concurrent.futures as cf

URL="https://mcp.coinmarketcap.com/skill-hub/stream"; KEY="0f0e0210a368485ab81b0fa2119c6f43"

def execute(name, params):
    body=json.dumps({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"execute_skill","arguments":{"unique_name":name,"parameters":params}}}).encode()
    req=urllib.request.Request(URL,data=body,headers={"Content-Type":"application/json","Accept":"application/json, text/event-stream","X-CMC-MCP-API-KEY":KEY})
    raw=urllib.request.urlopen(req,timeout=150).read().decode("utf-8","replace")
    for ln in raw.splitlines():
        if ln.startswith("data:"):
            r=json.loads(ln[5:].strip())
            try: return r["result"]["content"][0]["text"]
            except: return json.dumps(r)
    return raw

def deepest_error(txt):
    try: node=json.loads(txt)
    except: return (False, txt[:200])
    def err_of(j):
        if not isinstance(j,dict): return None
        e=j.get("error")
        if isinstance(e,dict) and (e.get("code") or e.get("message")):
            return f"{e.get('code')}: {e.get('message')}"
        if isinstance(e,str) and e.strip(): return e
        return None
    for _ in range(6):
        e=err_of(node)
        if e: return (False, e)
        if isinstance(node,dict) and isinstance(node.get("result"),dict):
            e=err_of(node["result"])
            if e: return (False,e)
            node=node["result"]; continue
        out=node.get("output") if isinstance(node,dict) else None
        if isinstance(out,str):
            try: node=json.loads(out); continue
            except: break
        break
    return (True, "OK (evidence pack)")

# (label, name, params)
CASES = [
  # A) ETF-vs-perp only supports BTC/ETH — fan choice, confirm BNB vs BTC.
  ("review_etf_flow_vs_perp_sentiment  BNB (current)", "review_etf_flow_vs_perp_sentiment", {"symbol":"BNB"}),
  ("review_etf_flow_vs_perp_sentiment  BTC (in-scope)", "review_etf_flow_vs_perp_sentiment", {"symbol":"BTC"}),
  # B) altcoin sector position — ETH is not an altcoin; try a real altcoin.
  ("assess_altcoin_sector_relative_position  ETH (current)", "assess_altcoin_sector_relative_position", {"symbol":"ETH"}),
  ("assess_altcoin_sector_relative_position  RENDER", "assess_altcoin_sector_relative_position", {"symbol":"RENDER"}),
  # C) supply overhang — majors have no unlocks; try a token with unlocks.
  ("review_token_supply_overhang  ETH (current)", "review_token_supply_overhang", {"token_id_or_symbol":"ETH"}),
  ("review_token_supply_overhang  ARB", "review_token_supply_overhang", {"token_id_or_symbol":"ARB"}),
  # D) liq cluster risk — does adding venue+window fix the 'evidence unavailable'?
  ("detect_liquidation_cluster_risk  {symbol} (current)", "detect_liquidation_cluster_risk", {"symbol":"BTC"}),
  ("detect_liquidation_cluster_risk  +venue+window", "detect_liquidation_cluster_risk", {"symbol":"BTC","venue":"Binance","window":"24h"}),
  # E) indicator watchlist — does adding universe+timeframe fix 'market data request failed'?
  ("build_indicator_trade_watchlist  {} (current)", "build_indicator_trade_watchlist", {}),
  ("build_indicator_trade_watchlist  +universe+tf", "build_indicator_trade_watchlist", {"universe":["BTC","ETH","SOL","LINK","AVAX"],"timeframe":"4h"}),
  # F) cross-asset regime — does time_window change the DATA_GAPS outcome?
  ("analyze_cross_asset_risk_regime  {} (current)", "analyze_cross_asset_risk_regime", {}),
  ("analyze_cross_asset_risk_regime  time_window=30d", "analyze_cross_asset_risk_regime", {"time_window":"30d"}),
]

def run(case):
    label,name,params=case
    try:
        ok,reason=deepest_error(execute(name,params))
        return (label, "OK " if ok else "ERR", reason[:200])
    except Exception as e:
        return (label, "EXC", str(e)[:200])

with cf.ThreadPoolExecutor(max_workers=12) as ex:
    for label,status,reason in ex.map(run, CASES):
        print(f"[{status}] {label}\n       -> {reason}\n")
