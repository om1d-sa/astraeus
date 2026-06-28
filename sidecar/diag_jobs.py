"""Read-only diagnostic: list ERC-8183 jobs that name our sidecar wallet as provider.

Run from sidecar/ with the venv active:
    python diag_jobs.py
"""
import os

os.environ.setdefault("RPC_URL", "https://bsc-testnet-rpc.publicnode.com")

from bnbagent.erc8183 import ERC8183Client
from bnbagent.erc8183.types import JobStatus

SELLER = "0x6E94090e6fF3675D8962941A64D2b4265d667BBF".lower()

client = ERC8183Client(None, network="bsc-testnet")
counter = client.commerce.job_counter()
print(f"global jobCounter = {counter}")
print(f"looking for jobs with provider == {SELLER}\n")

mine = 0
# scan the most recent 40 jobs (enough for a demo session)
start = max(1, counter - 40 + 1)
for jid in range(start, counter + 1):
    try:
        job = client.commerce.get_job(jid)
    except Exception as e:
        print(f"  job {jid}: read error {e}")
        continue
    if job.provider.lower() == SELLER:
        mine += 1
        try:
            status = JobStatus(job.status).name
        except Exception:
            status = str(job.status)
        print(
            f"  job {jid}: status={status} client={job.client} "
            f"budget={job.budget} expiredAt={job.expired_at} "
            f"submittedAt={job.submitted_at}"
        )

if mine == 0:
    print("  -> NO jobs reference this provider. The buyer has not funded a job to it.")
