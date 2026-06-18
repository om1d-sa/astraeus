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

## Security

- `sidecar/.env` is gitignored — never commit it.
- The sidecar wallet is for ERC-8183 escrow only; **do not** fund it with trading capital.
- Keep `WALLET_PASSWORD` in a password manager (the keystore at `~/.bnbagent/` needs it).
