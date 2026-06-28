# Astraeus ERC-8183 Sidecar (BNB AI Agent SDK)

An **optional, fully-decoupled** service that uses the **BNB AI Agent SDK** (`bnbagent`)
to sell Astraeus's ETH forecast as an **on-chain ERC-8183 paid job**: another AI agent
funds an escrow, this server delivers Astraeus's latest forecast, and payment settles
optimistically on BNB Smart Chain.

This targets the hackathon's **"Best Use of BNB AI Agent SDK"** special prize using the
SDK's flagship **agentic-commerce (ERC-8183)** layer.

## Why it's safe (quarantine boundaries)

This process **cannot** affect the trading agent's performance or PnL:

| Boundary | Guarantee |
|---|---|
| Process | Separate Python runtime — a crash here never touches the Node trade loop |
| Wallet | Its **own** key (auto-generated, encrypted to `~/.bnbagent/wallets/`) — **not** the TWAK trading wallet; it never holds trading capital or signs trades |
| Coupling | It only **reads** the `data/latest-forecast.json` file the agent writes — no imports, no calls into the trade loop |
| Failure mode | If the agent is down, it serves the last-known forecast (or an error); if the sidecar is down, trading continues unaffected |

## Setup

Requires **Python 3.10+** (separate from the Node/Bun agent).

```bash
cd sidecar
python -m venv .venv
# Windows PowerShell:
.\.venv\Scripts\Activate.ps1
# macOS/Linux:
# source .venv/bin/activate

pip install -r requirements.txt
cp .env.example .env          # then edit .env (set WALLET_PASSWORD; keep NETWORK=bsc-testnet)
```

> **Start on `bsc-testnet`** — registration/identity is gas-free there (MegaFuel paymaster),
> so you can demo the full ERC-8183 flow with **no real funds at risk**.

## Run

First, **enable the bridge in the agent's `.env`** so it publishes forecasts for the
sidecar (off by default):

```bash
ERC8183_SIDECAR_ENABLED=true
```

Then make sure the Astraeus agent has produced at least one forecast (so
`../data/latest-forecast.json` exists), and start the server:

```bash
uvicorn astraeus_erc8183:app --host 0.0.0.0 --port 8183
```

Key routes (served by the SDK):

| Method | Path | Purpose |
|---|---|---|
| GET | `/erc8183/health` | liveness |
| GET | `/erc8183/status` | wallet, contract addresses, service price |
| POST | `/erc8183/negotiate` | off-chain price negotiation |
| GET | `/erc8183/job/{id}/response` | the delivered forecast |

When a client funds a job, the SDK calls `serve_forecast()` in
[`astraeus_erc8183.py`](astraeus_erc8183.py), which returns Astraeus's latest forecast
as the deliverable.

## How the forecast gets here

The Node agent writes `data/latest-forecast.json` after every forecast (a tiny,
best-effort, non-blocking write — see `persistLatestForecast` in
`src/agent/service.ts`). This sidecar reads that file read-only. There is no other
link between the two processes.

## Buy a forecast (buyer side, ERC-8183 client)

The steps above run the **provider/seller**. To prove the full agentic-commerce flow
you fund one on-chain job from a **separate buyer wallet** — [`client_demo.py`](client_demo.py)
does exactly this and prints three real bsc-testnet tx hashes
(`create_job` → `fund` → `settle`).

Keep the sidecar running (it's the provider); do everything below in a **second**
PowerShell window.

**1. Get the provider address.** With the sidecar running, open
<http://localhost:8183/erc8183/status> and copy the `wallet`/`address` field
(or run `python show_address.py`). That's your `PROVIDER_ADDRESS`.

**2. Create a separate buyer wallet** — its **own** key, never the sidecar or trading
key:

```powershell
cd sidecar
.\.venv\Scripts\Activate.ps1
python -c "from eth_account import Account; a=Account.create(); print('ADDRESS', a.address); print('KEY', a.key.hex())"
```

Save both lines: `ADDRESS` is what you fund, `KEY` becomes `CLIENT_PRIVATE_KEY`.
(A new MetaMask account with its private key exported works too.)

**3. Fund the buyer ADDRESS on bsc-testnet:**

| Need | Faucet |
|---|---|
| tBNB (gas — ~0.01 per run, 0.3 covers dozens) | <https://www.bnbchain.org/en/testnet-faucet> |
| U token (payment — 1 U per job) | <https://united-coin-u.github.io/u-faucet/> |

**4. Give the buyer its three values.** Either export them in the shell (same venv,
PowerShell syntax)…

```powershell
$env:CLIENT_PRIVATE_KEY = "0x...buyer key from step 2..."
$env:CLIENT_PASSWORD     = "any-password-to-encrypt-the-local-keystore"
$env:PROVIDER_ADDRESS    = "0x...sidecar address from step 1..."
```

…**or** (recommended) drop them once into a gitignored `sidecar/.env.buyer` file so
you never have to re-export them:

```bash
# sidecar/.env.buyer
CLIENT_PRIVATE_KEY=0x...buyer key from step 2...
CLIENT_PASSWORD=any-password-to-encrypt-the-local-keystore
PROVIDER_ADDRESS=0x...sidecar address from step 1...
```

**5. Buy a forecast:**

```powershell
python client_demo.py
```

It runs `create_job → register_job → set_budget → fund → [sidecar delivers]` and
returns as soon as the sidecar delivers (status **SUBMITTED**) — that is the full
agentic-commerce round-trip, with real `create_job` / `fund` / `submit` tx hashes.

**6. Finalize later (optional).** ERC-8183 settles **optimistically**: the job
auto-approves only after the policy's dispute window elapses (~1 day on bsc-testnet).
Once it has, flip it to **COMPLETED** with:

```powershell
python client_demo.py --settle <jobId>
```

View every tx at `https://testnet.bscscan.com/address/<PROVIDER_ADDRESS>`.

> The buyer wallet is **reusable** — each run creates a fresh job. Keep the same key
> and `CLIENT_PASSWORD` across runs (a new password won't open the existing keystore),
> and make sure it still holds tBNB + U tokens. Only generate a new key if you want a
> clean wallet.

> Sidecar and buyer must be on the **same network**. `client_demo.py` reads `NETWORK`
> (default `bsc-testnet`) and `RPC_URL` from the environment / `sidecar/.env`, so keep
> `NETWORK=bsc-testnet` in the sidecar `.env`.

## Security

- `sidecar/.env` and `sidecar/.env.buyer` are gitignored — never commit them (the
  latter holds the buyer wallet's private key).
- The sidecar wallet is for ERC-8183 escrow only; **do not** fund it with trading capital.
- Keep `WALLET_PASSWORD` in a password manager (the keystore at `~/.bnbagent/` needs it).
