"""
ERC-8183 CLIENT — the BUYER side. Buy ONE Astraeus forecast as an on-chain job.

This funds a single on-chain job against the Astraeus sidecar (the provider) on
bsc-testnet, producing real transaction hashes you can attach to a submission as
proof of the agentic-commerce (ERC-8183) flow:

    create_job  (buyer)  ->  fund  (buyer)  ->  submit  (sidecar/provider)

It uses a SEPARATE "buyer" wallet — never the TWAK trading wallet, never the
sidecar wallet.

PREREQUISITES
  1. The sidecar is running on bsc-testnet (it is the provider that delivers).
     Get its PROVIDER address from GET http://localhost:8183/erc8183/status
     (the "wallet"/"address" field) or `python show_address.py`.
  2. A buyer wallet (its OWN key) funded on bsc-testnet with:
        - tBNB (gas)     -> https://www.bnbchain.org/en/testnet-faucet
        - U tokens (pay) -> https://united-coin-u.github.io/u-faucet/
  3. Three values, via environment variables OR a `.env.buyer` file (see below):
        CLIENT_PRIVATE_KEY=0x....   (the buyer wallet's key)
        CLIENT_PASSWORD=....        (encrypts the local keystore)
        PROVIDER_ADDRESS=0x....     (the sidecar wallet, from /erc8183/status)

RUN
        python client_demo.py                 # buy one forecast
        python client_demo.py --settle <id>   # finalize a delivered job later

WHY TWO STEPS?  ERC-8183 settles *optimistically*: once the provider delivers,
the job auto-approves only after the policy's dispute window elapses (on
bsc-testnet that is ~1 day). So `python client_demo.py` returns as soon as the
forecast is delivered (status SUBMITTED) — that is the full round-trip proof —
and you run `--settle <id>` after the window to flip it to COMPLETED.

TIP: to avoid re-exporting the three vars in every new terminal, drop them in a
`sidecar/.env.buyer` file (gitignored). This script loads it automatically.
"""

import argparse
import os
import time
import urllib.request
from pathlib import Path

_HERE = Path(__file__).resolve().parent


def _load_env_file(path: Path, only: set[str] | None = None) -> None:
    """setdefault os.environ from a KEY=VALUE file (existing env always wins).

    When ``only`` is given, just those keys are imported. That guard is how we
    inherit the provider's network settings from sidecar/.env WITHOUT ever
    importing its PRIVATE_KEY / WALLET_PASSWORD into this buyer process.
    """
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key, value = key.strip(), value.strip()
        if only is not None and key not in only:
            continue
        if value:
            os.environ.setdefault(key, value)


# Buyer-specific values (optional, gitignored). Persist CLIENT_* / PROVIDER_ADDRESS
# here so a plain `python client_demo.py` works without re-exporting each session.
_load_env_file(_HERE / ".env.buyer")
# Inherit ONLY the safe network settings from the provider's .env — never its key.
_load_env_file(_HERE / ".env", only={"RPC_URL", "NETWORK"})
# The SDK's built-in bsc-testnet RPC default is decommissioned (DNS failure);
# guarantee a live endpoint before the SDK resolves the network.
os.environ.setdefault("RPC_URL", "https://bsc-testnet-rpc.publicnode.com")

from bnbagent.erc8183 import ERC8183Client, JobStatus, Verdict  # noqa: E402
from bnbagent.wallets import EVMWalletProvider  # noqa: E402

NETWORK = os.environ.get("NETWORK", "bsc-testnet")
# Extra seconds, on top of the policy dispute window, granted for the provider to
# deliver. expired_at = now + dispute_window + buffer guarantees the SDK's
# create_job pre-flight passes and leaves the provider `buffer` seconds to submit.
EXPIRY_BUFFER_SECONDS = int(os.environ.get("JOB_EXPIRY_BUFFER_SECONDS", str(86400)))
DELIVERY_TIMEOUT_SECONDS = 6 * 60  # how long to wait for the sidecar to deliver


def _require(name: str) -> str:
    val = os.environ.get(name)
    if not val:
        raise SystemExit(
            f"Missing {name}. Set it as an env var or add it to sidecar/.env.buyer.\n"
            "  CLIENT_PRIVATE_KEY = buyer wallet key (0x...)\n"
            "  CLIENT_PASSWORD    = any password to encrypt the local keystore\n"
            "  PROVIDER_ADDRESS   = sidecar address from /erc8183/status"
        )
    return val


def _build_client() -> ERC8183Client:
    wallet = EVMWalletProvider(
        password=_require("CLIENT_PASSWORD"),
        private_key=_require("CLIENT_PRIVATE_KEY"),
    )
    return ERC8183Client(wallet, network=NETWORK)


def _fetch_deliverable(client: ERC8183Client, job_id: int) -> None:
    """Best-effort: resolve the delivered forecast URL and print its contents."""
    try:
        url = client.get_deliverable_url(job_id)
    except Exception as exc:  # event scan / RPC hiccup — non-fatal
        print(f"    (could not resolve deliverable URL yet: {exc})")
        return
    if not url:
        print("    (deliverable URL not published yet)")
        return
    print(f"    deliverable URL: {url}")
    try:
        with urllib.request.urlopen(url, timeout=10) as resp:
            body = resp.read().decode("utf-8", "replace")
        print(f"    delivered forecast: {body}")
    except Exception as exc:
        print(f"    (URL not fetchable from here — that's fine: {exc})")


def _settle_timing_note(client: ERC8183Client, job_id: int) -> None:
    """Explain when optimistic settlement becomes possible for a SUBMITTED job."""
    try:
        submitted_at = int(client.policy.submitted_at(job_id))
        window = int(client.policy.dispute_window())
    except Exception:
        return
    if submitted_at <= 0:
        return
    ready_at = submitted_at + window
    remaining = max(0, ready_at - int(time.time()))
    print(
        f"    optimistic approval unlocks in ~{remaining // 3600}h{(remaining % 3600) // 60}m "
        f"(at unix {ready_at}). Then run:  python client_demo.py --settle {job_id}"
    )


def settle(job_id: int) -> None:
    """Finalize a delivered job once its dispute window has elapsed."""
    client = _build_client()
    status = client.get_job_status(job_id)
    print(f"job {job_id}: status={status.name}")
    if status == JobStatus.COMPLETED:
        print("already COMPLETED — nothing to do.")
        return
    if status not in (JobStatus.SUBMITTED,):
        print(f"job is {status.name}, not SUBMITTED — cannot settle yet.")
        return

    verdict, _ = client.get_verdict(job_id)
    print(f"current policy verdict: {verdict.name}")
    if verdict != Verdict.APPROVE:
        _settle_timing_note(client, job_id)
        return

    res = client.settle(job_id)
    print(f"settle tx: {res.get('transactionHash', res)}")
    print(f"final status: {client.get_job_status(job_id).name}")


def buy() -> None:
    provider = _require("PROVIDER_ADDRESS")
    client = _build_client()

    decimals = client.token_decimals()
    budget = 1 * (10 ** decimals)  # 1 U token

    now = int(time.time())
    try:
        dispute_window = int(client.policy.dispute_window())
    except Exception:
        dispute_window = 86400  # safe fallback if the read fails
    expired_at = now + dispute_window + EXPIRY_BUFFER_SECONDS

    print(f"buyer={client.address}  provider={provider}  network={NETWORK}")
    print(
        f"budget={budget / 10**decimals} {client.token_symbol()}  "
        f"dispute_window={dispute_window}s  expired_at=+{expired_at - now}s"
    )

    # 1) Create the job on-chain  -> TX HASH #1
    res = client.create_job(
        provider=provider,
        expired_at=expired_at,
        description="Astraeus ETH directional forecast",
    )
    job_id = res["jobId"]
    print(f"[1] create_job tx: {res['transactionHash']}  (jobId={job_id})")

    # 2) Register the policy, set the budget, fund the escrow  -> TX HASH #2
    client.register_job(job_id)
    client.set_budget(job_id, budget)
    fund_res = client.fund(job_id, budget)
    print(f"[2] fund tx: {fund_res.get('transactionHash', fund_res)}")
    print("    job funded — waiting for the sidecar to poll, deliver, and submit...")

    # 3) Wait for the provider (sidecar) to deliver  -> TX HASH #3 is its submit().
    deadline = time.time() + DELIVERY_TIMEOUT_SECONDS
    last = None
    status = client.get_job_status(job_id)
    while status not in (JobStatus.SUBMITTED, JobStatus.COMPLETED) and time.time() < deadline:
        if status != last:
            print(f"    status: {status.name}")
            last = status
        time.sleep(10)
        status = client.get_job_status(job_id)

    print(f"    status: {status.name}")
    if status not in (JobStatus.SUBMITTED, JobStatus.COMPLETED):
        print(
            "\nThe sidecar has not delivered yet. Make sure it is running "
            "(uvicorn astraeus_erc8183:app ...) and has a forecast available, "
            f"then settle later with:  python client_demo.py --settle {job_id}"
        )
        return

    print("[3] delivered by provider (on-chain submit). Forecast:")
    _fetch_deliverable(client, job_id)

    # 4) Optimistic settlement: only possible after the dispute window.
    if status == JobStatus.COMPLETED:
        print("\nJob already COMPLETED.")
    else:
        verdict, _ = client.get_verdict(job_id)
        if verdict == Verdict.APPROVE:
            settle_res = client.settle(job_id)
            print(f"[4] settle tx: {settle_res.get('transactionHash', settle_res)}")
            print(f"    final status: {client.get_job_status(job_id).name}")
        else:
            print("\nForecast delivered — agentic-commerce round-trip complete.")
            _settle_timing_note(client, job_id)

    print("\nView every tx on the testnet explorer:")
    print(f"  https://testnet.bscscan.com/address/{provider}")


def main() -> None:
    parser = argparse.ArgumentParser(description="ERC-8183 buyer for Astraeus forecasts")
    parser.add_argument(
        "--settle",
        type=int,
        metavar="JOB_ID",
        help="finalize a previously delivered job (after its dispute window)",
    )
    args = parser.parse_args()
    if args.settle is not None:
        settle(args.settle)
    else:
        buy()


if __name__ == "__main__":
    main()
