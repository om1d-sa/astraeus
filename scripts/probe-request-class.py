#!/usr/bin/env python3
"""Probe v2: parse the NESTED error (result.output is a JSON string) and try refined
params for the monitor skills that accepted their request_class but wanted more."""
import json, urllib.request, concurrent.futures as cf

URL = "https://mcp.coinmarketcap.com/skill-hub/stream"
KEY = "0f0e0210a368485ab81b0fa2119c6f43"

def execute(name, params):
    body = json.dumps({"jsonrpc":"2.0","id":1,"method":"tools/call",
        "params":{"name":"execute_skill","arguments":{"unique_name":name,"parameters":params}}}).encode()
    req = urllib.request.Request(URL, data=body, headers={
        "Content-Type":"application/json","Accept":"application/json, text/event-stream",
        "X-CMC-MCP-API-KEY":KEY})
    raw = urllib.request.urlopen(req, timeout=300).read().decode("utf-8","replace")
    for line in raw.splitlines():
        if line.startswith("data:"):
            r = json.loads(line[5:].strip())
            try: return r["result"]["content"][0]["text"]
            except Exception: return json.dumps(r)
    return raw

def inner_status(txt):
    """Drill into nested result.output JSON and return (ok, short_reason)."""
    def err_of(j):
        if not isinstance(j, dict): return None
        e = j.get("error")
        if isinstance(e, dict) and (e.get("code") or e.get("message")):
            return f"{e.get('code')}: {e.get('message')}"
        if isinstance(e, str) and e.strip(): return e
        return None
    try:
        j = json.loads(txt)
    except Exception:
        return (False, txt[:160])
    # unwrap result.output (JSON string) repeatedly
    node = j
    for _ in range(4):
        e = err_of(node)
        if e: return (False, e)
        res = node.get("result") if isinstance(node, dict) else None
        if isinstance(res, dict):
            e = err_of(res)
            if e: return (False, e)
            node = res
            continue
        out = node.get("output") if isinstance(node, dict) else None
        if isinstance(out, str):
            try: node = json.loads(out); continue
            except Exception: break
        break
    return (True, "evidence_pack/ok")

AAVE = "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9"
CASES = [
    ("summarize_x_social_market_signals", {"request_class":"summarize_x_social_market_signals","limit":10}),
    ("summarize_x_social_market_signals", {"request_class":"summarize_x_social_market_signals","limit":10,"live_fetch":True}),
    ("token_holder_and_dex_flow_monitor", {"request_class":"token_holder_dex_flow_monitor","live_fetch":True,
        "token":{"symbol":"AAVE","platform":"ethereum","address":AAVE}}),
    ("token_holder_and_dex_flow_monitor", {"request_class":"token_holder_dex_flow_monitor",
        "token":{"symbol":"AAVE"},"holder_snapshot":{"holder_count":200000,"top_10_pct":35},
        "dex_flows":[{"window":"24h","swap_count":1000,"net_buy_usd":500000,"volume_usd":5000000}],
        "pools":[{"pool":"AAVE/WETH","liquidity_usd":10000000,"volume_24h_usd":2000000}]}),
    ("token_unlock_pressure_monitor", {"request_class":"token_unlock_pressure_monitor","live_fetch":True,
        "unlocks":[{"token":"ARB","unlock_value_usd":50000000,"circulating_supply_usd":2000000000,"unlock_date":"2026-07-01"}]}),
    ("rank_token_unlock_supply_pressure", {"request_class":"rank_token_unlock_supply_pressure","live_fetch":True}),
]

def run(case):
    name, params = case
    try:
        ok, reason = inner_status(execute(name, params))
        return (name, json.dumps(params)[:90], "OK" if ok else "ERR", reason[:180])
    except Exception as e:
        return (name, json.dumps(params)[:90], "EXC", str(e)[:180])

with cf.ThreadPoolExecutor(max_workers=8) as ex:
    for name, p, status, reason in ex.map(run, CASES):
        print(f"[{status}] {name}\n      params={p}\n      -> {reason}\n")
