"""
Settle every delivered-but-unpaid ERC-8183 job for a given seller, in one shot.

ERC-8183 settles *optimistically*: after the provider delivers (``submit``) and the
policy dispute window elapses, the job auto-APPROVES — but the escrowed payment only
moves to the seller when someone sends a permissionless ``settle(jobId)`` tx. Nothing
calls it for you, so funded+delivered jobs sit in escrow until settled.

This script scans the chain for jobs where:
    provider == <seller>   AND   status == SUBMITTED   AND   verdict == APPROVE
and sends ``settle`` for each, releasing the U from escrow to the seller. ``settle``
is permissionless, so it is signed with the BUYER wallet (any funded wallet works);
the payout still goes to the seller named on each job.

RUN (buyer terminal, venv active — same env as client_demo.py):
    python settle_all.py              # settle everything that's ready
    python settle_all.py --dry-run    # just list, sign/settle nothing (no key needed)
    python settle_all.py --provider 0xSELLER...   # override the seller filter

The seller defaults to PROVIDER_ADDRESS (or SELLER_ADDRESS) from your env / .env.buyer.
"""

import argparse
import os
import time
from pathlib import Path

_HERE = Path(__file__).resolve().parent


def _load_env_file(path: Path, only: set[str] | None = None) -> None:
    """setdefault os.environ from a KEY=VALUE file (existing env always wins).

    With ``only`` set, just those keys are imported — used to inherit the
    provider's network settings from sidecar/.env without ever importing its
    PRIVATE_KEY / WALLET_PASSWORD into this buyer process.
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


_load_env_file(_HERE / ".env.buyer")
_load_env_file(_HERE / ".env", only={"RPC_URL", "NETWORK"})
os.environ.setdefault("RPC_URL", "https://bsc-testnet-rpc.publicnode.com")

from web3 import Web3  # noqa: E402
from bnbagent.erc8183 import ERC8183Client, JobStatus, Verdict  # noqa: E402
from bnbagent.wallets import EVMWalletProvider  # noqa: E402

NETWORK = os.environ.get("NETWORK", "bsc-testnet")


def _resolve_seller(cli_value: str | None) -> str:
    seller = cli_value or os.environ.get("SELLER_ADDRESS") or os.environ.get("PROVIDER_ADDRESS")
    if not seller:
        raise SystemExit(
            "No seller address. Pass --provider 0x... or set PROVIDER_ADDRESS "
            "(or SELLER_ADDRESS) in your env / sidecar/.env.buyer."
        )
    return Web3.to_checksum_address(seller)


def _build_client(*, signing: bool) -> ERC8183Client:
    if not signing:
        return ERC8183Client(None, network=NETWORK)
    pw = os.environ.get("CLIENT_PASSWORD")
    key = os.environ.get("CLIENT_PRIVATE_KEY")
    if not pw or not key:
        raise SystemExit(
            "Settling needs a signing wallet. Set CLIENT_PASSWORD and "
            "CLIENT_PRIVATE_KEY (env or sidecar/.env.buyer), or use --dry-run."
        )
    return ERC8183Client(EVMWalletProvider(password=pw, private_key=key), network=NETWORK)


def main() -> None:
    parser = argparse.ArgumentParser(description="Settle all ready ERC-8183 jobs for a seller")
    parser.add_argument("--provider", help="seller address to settle for (default: PROVIDER_ADDRESS)")
    parser.add_argument("--dry-run", action="store_true", help="list ready jobs but settle nothing")
    args = parser.parse_args()

    seller = _resolve_seller(args.provider).lower()
    client = _build_client(signing=not args.dry_run)

    counter = client.commerce.job_counter()
    dispute_window = int(client.policy.dispute_window())
    now = int(time.time())
    print(f"seller={Web3.to_checksum_address(seller)}  network={NETWORK}")
    print(f"scanning {counter} jobs (dispute_window={dispute_window}s)...\n")

    jobs = client.commerce.get_jobs_batch(list(range(1, counter + 1)))
    seller_submitted = [j for j in jobs if j is not None and j.provider.lower() == seller and j.status == JobStatus.SUBMITTED]

    if not seller_submitted:
        print("No SUBMITTED jobs for this seller — nothing pending.")
        # Surface what *is* there so the run is never silent/confusing.
        owned = [j for j in jobs if j is not None and j.provider.lower() == seller]
        if owned:
            done = sum(1 for j in owned if j.status == JobStatus.COMPLETED)
            print(f"(seller has {len(owned)} jobs total; {done} already COMPLETED.)")
        return

    ready: list[int] = []
    waiting: list[tuple[int, int]] = []  # (job_id, seconds_remaining)
    for j in seller_submitted:
        try:
            verdict, _ = client.get_verdict(j.id)
        except Exception as exc:
            print(f"  job {j.id}: verdict read failed, skipping ({exc})")
            continue
        if verdict == Verdict.APPROVE:
            ready.append(j.id)
        else:
            ready_at = (j.submitted_at or 0) + dispute_window
            waiting.append((j.id, max(0, ready_at - now)))

    for job_id, remaining in waiting:
        print(f"  job {job_id}: delivered, verdict still PENDING — settles in ~{remaining // 3600}h{(remaining % 3600) // 60}m")

    if not ready:
        print("\nNothing is settle-able yet (dispute windows still open). Re-run later.")
        return

    print(f"\n{len(ready)} job(s) ready to settle: {ready}")
    if args.dry_run:
        print("--dry-run: not sending any transactions.")
        return

    settled = 0
    for job_id in ready:
        try:
            res = client.settle(job_id)
            print(f"  job {job_id}: settle tx {res.get('transactionHash', res)} -> {client.get_job_status(job_id).name}")
            settled += 1
        except Exception as exc:
            print(f"  job {job_id}: settle FAILED ({exc})")

    print(f"\nDone: settled {settled}/{len(ready)} job(s). Released escrow to {Web3.to_checksum_address(seller)}.")
    print(f"  https://testnet.bscscan.com/address/{Web3.to_checksum_address(seller)}")


if __name__ == "__main__":
    main()
