"""
ERC-8183 CLIENT demo — the BUYER side.

Funds ONE on-chain job against the Astraeus sidecar (the provider) on bsc-testnet to
produce real transaction hashes (create_job / fund / settle) you can attach to your
hackathon submission as proof of the agentic-commerce (ERC-8183) flow.

This is OPTIONAL and completely separate from the trading agent. It uses a SEPARATE
"buyer" wallet — never the TWAK trading wallet.

PREREQUISITES
  1. The sidecar is running on bsc-testnet. Get its PROVIDER address from:
        GET http://localhost:8183/erc8183/status   (the "wallet"/"address" field)
  2. A buyer wallet (its own key) funded on bsc-testnet with:
        - tBNB (gas)     -> https://www.bnbchain.org/en/testnet-faucet
        - U tokens (pay) -> https://united-coin-u.github.io/u-faucet/
  3. Environment (set these before running, in the SAME venv as the sidecar):
        CLIENT_PRIVATE_KEY=0x....   (the buyer wallet's key)
        CLIENT_PASSWORD=....        (encrypts the local keystore)
        PROVIDER_ADDRESS=0x....     (the sidecar wallet, from /erc8183/status)

RUN
        python client_demo.py

NOTE: this follows the SDK's documented flow
  create_job -> register_job -> set_budget -> fund -> [provider delivers] -> settle.
If any method name/timing differs in your SDK version, compare with the official
happy-path in the SDK's  examples/client/  directory.
"""

import os
import time

from bnbagent.erc8183 import ERC8183Client, JobStatus
from bnbagent.wallets import EVMWalletProvider


def main() -> None:
    provider = os.environ["PROVIDER_ADDRESS"]
    wallet = EVMWalletProvider(
        password=os.environ["CLIENT_PASSWORD"],
        private_key=os.environ["CLIENT_PRIVATE_KEY"],
    )
    client = ERC8183Client(wallet, network="bsc-testnet")

    budget = 1 * (10 ** client.token_decimals())  # 1 U token
    expired_at = int(time.time()) + 65 * 60  # 65-minute job window

    # 1) Create the job on-chain  -> TX HASH #1
    res = client.create_job(
        provider=provider,
        expired_at=expired_at,
        description="Astraeus ETH directional forecast",
    )
    job_id = res["jobId"]
    print(f"[1] create_job tx: {res['transactionHash']}  (jobId={job_id})")

    # 2) Register to the default optimistic policy, set budget, and fund the escrow
    client.register_job(job_id)
    client.set_budget(job_id, budget)
    fund_res = client.fund(job_id, budget)  # -> TX HASH #2
    print(f"[2] fund tx: {fund_res.get('transactionHash', fund_res)}")
    print("    job funded — the sidecar will poll, deliver the forecast, and submit on-chain...")

    # 3) Wait for the provider (sidecar) to deliver, then settle  -> TX HASH #3
    for _ in range(60):  # up to ~10 minutes
        status = client.get_job_status(job_id)
        print(f"    status: {status}")
        if status == JobStatus.COMPLETED:
            break
        try:
            settle_res = client.settle(job_id)  # finalizes once the dispute window passes
            print(f"[3] settle tx: {settle_res.get('transactionHash', settle_res)}")
        except Exception as e:  # not settle-able yet — keep waiting
            print(f"    (not settle-able yet: {e})")
        time.sleep(10)

    print(f"\nFinal status: {client.get_job_status(job_id)}")
    print("View every tx on the testnet explorer:")
    print(f"  https://testnet.bscscan.com/address/{provider}")


if __name__ == "__main__":
    main()
