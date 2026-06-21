# astraeus
a Predicting Ai Agent for overall market status and BTC, ETH, and BNB price, also do profitable trades on BSC chain.🎇

---

_Created by **Omid Sa** · Powered by **ElizaOS**, the **CoinMarketCap AI Agent Hub**, the **Trust Wallet Agent Kit**, and the **BNB AI Agent SDK** — trading live on **BNB Chain**._

---

Four pieces make Astraeus a genuinely hands-off, self-custody trader rather than an LLM with a swap bolted on:

### 🧠 The brain — CoinMarketCap AI Agent Hub

CMC is the agent's entire market read. Every forecast and trade decision is built from CMC data, on two layers:

- **Live REST data** — spot price, RSI/MACD/EMA technicals, global market regime (total cap, BTC dominance), Fear & Greed, trending tokens, DEX pairs and news.
- **CMC Skill Hub skills via MCP** (`find_skill` → `execute_skill`) — 60+ skills, bundled per feature: funding‑rate regimes, liquidation magnets, ETF flows, options skew/IV term‑structure, short‑squeeze fuel, holder concentration, and more.

These are fused (options/derivatives data ~60% + CMC enrichment ~40%) into calibrated **BTC / ETH / BNB** directional forecasts, which then drive the autonomous trade loop. Toggle the heavy skill layer with `CMC_SKILLS_ENABLED`.

### 💸 x402 — pay-per-request data, paid by the agent

Astraeus pays for premium CMC data **per request** using the **x402** micropayment standard, with the payment authorization **signed by the Trust Wallet Agent Kit** (self-custody — no API key handed over). Each trade cycle it can fetch x402-gated CMC endpoints (e.g. `quotes/latest`, `dex/search`) to enrich the forecast, settling a few cents of USDC on Base per call.

- Configure: `X402_ENRICH=true`, `X402_DATA_URL=<comma-separated CMC x402 URLs>`, `X402_MAX_PAYMENT` (atomic cap, e.g. `10000` = 0.01 USDC).
- From chat: **`x402 quote <url>`** previews the price (read-only), **`x402 pay <url>`** makes the call and signs the payment if the endpoint requires one.
- Best-effort + bounded: any failure falls back to the free data path and never blocks a trade.

### 🪪 ERC-8004 — on-chain agent identity

Astraeus mints and reads its own **ERC-8004** on-chain agent identity on BSC — the BNB AI Agent SDK's identity standard — signed through TWAK, so custody never leaves the user.

- **`register my agent identity`** → mints the identity NFT on BSC (needs a little BNB for gas).
- **`show identity <id>`** → reads its on-chain state (URI / metadata).
- Toggle with `ERC8004_IDENTITY_ENABLED` (on by default).

### 🧩 ERC-8183 — sell your forecasts as on-chain jobs

With the optional Python **sidecar** (in [`sidecar/`](sidecar/)), Astraeus turns its forecasts into a sellable **ERC-8183** on-chain job: when `ERC8183_SIDECAR_ENABLED=true`, every forecast is published to `data/latest-forecast.json`, and the sidecar serves it as a paid job others can buy on-chain.
