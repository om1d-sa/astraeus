"""
Astraeus ERC-8183 sidecar — sells Astraeus's ETH forecast as an on-chain paid job.

This uses the BNB AI Agent SDK (`bnbagent`) ERC-8183 *agentic-commerce* layer:
another AI agent funds an on-chain escrow job, this server delivers Astraeus's
latest forecast, and payment settles optimistically.

QUARANTINE — this process is fully decoupled from the trading agent:
  * separate runtime (Python), separate process
  * its OWN wallet (auto-generated, encrypted to ~/.bnbagent/wallets/) — NOT the
    TWAK trading wallet; it never holds trading capital or signs trades
  * it only READS the forecast file the trading agent writes; it never imports,
    calls, or blocks the trade loop. If this server dies, trading is unaffected.

Run:
    pip install "bnbagent[server,ipfs]"
    uvicorn astraeus_erc8183:app --host 0.0.0.0 --port 8183
"""

import json
import os
from pathlib import Path

from bnbagent.erc8183.server import create_erc8183_app

# Shared file the Node trading agent writes after every forecast (read-only here).
FORECAST_FILE = Path(
    os.getenv("ASTRAEUS_FORECAST_FILE", str(Path(__file__).resolve().parent.parent / "data" / "latest-forecast.json"))
)


def _load_latest_forecast() -> dict:
    """Best-effort read of the agent's latest forecast. Returns {} if unavailable."""
    try:
        return json.loads(FORECAST_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def serve_forecast(job: dict) -> str:
    """
    Deliver Astraeus's latest ETH forecast as the job result.

    Called automatically by the SDK for each FUNDED job. The return string is the
    deliverable stored on-chain/off-chain and released to the client on settlement.
    """
    f = _load_latest_forecast()
    if not f:
        return json.dumps({"error": "no forecast available yet — start the Astraeus agent first"})

    deliverable = {
        "service": "Astraeus ETH directional forecast",
        "asset": f.get("asset", "ETH"),
        "timeframe": f.get("timeframe"),
        "direction": f.get("direction"),
        "confidence": f.get("confidence"),
        "currentPrice": f.get("currentPrice"),
        "targetPrice": f.get("targetPrice"),
        "priceChange": f.get("priceChange"),
        "reasoning": f.get("reasoning"),
        "asOf": f.get("timestamp"),
        "jobId": job.get("jobId"),
    }
    return json.dumps(deliverable)


# Spins up the ERC-8183 FastAPI server: negotiation, funding, job execution
# (serve_forecast) and settlement, all per the on-chain ERC-8183 standard.
app = create_erc8183_app(on_job=serve_forecast)
