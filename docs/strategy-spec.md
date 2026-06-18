# Astraeus — Strategy Specification (BNB Hack, Track 2)

Astraeus is an autonomous crypto trading agent for BNB Smart Chain. This document
specifies its **strategy skills** — the deterministic logic that turns market data
into trade decisions — and the backtest methodology used to validate them. The
same logic powers the live Track 1 agent (execution via Trust Wallet Agent Kit).

Astraeus ships **two complementary strategy skills**:

1. **Composite Momentum + Sentiment** — a fast, deterministic, backtestable spot
   strategy over the eligible BEP-20 universe. *(This is the Track 2 deliverable.)*
2. **Options-Implied Forecast** — an LLM forecast of BTC / ETH / BNB direction
   across 4 timeframes, derived from options + futures market structure.

---

## 1. Composite Momentum + Sentiment skill

**Source:** [`src/strategy/strategy.ts`](../src/strategy/strategy.ts) · types in
[`src/strategy/types.ts`](../src/strategy/types.ts)

### Inputs (per token, from the CoinMarketCap AI Agent Hub)

| Signal | Field | Source |
|---|---|---|
| Trend | `emaFast`, `emaSlow` | CMC pre-computed EMA |
| Momentum | `macdHist` | CMC pre-computed MACD |
| Mean reversion | `rsi14` | CMC pre-computed RSI |
| Sentiment | `fearGreed` (market-wide) | CMC Fear & Greed Index |
| Positioning | `fundingRate` | CMC derivatives |
| Liquidity gate | `volume24hUsd` | CMC |

### Signal model

Each sub-signal is normalized to `[-1, 1]` (positive = bullish), weighted, and
combined into a composite score. **Missing inputs are skipped and the remaining
weights renormalize**, so the agent still decides on partial data.

| Sub-signal | Rule | Default weight |
|---|---|---|
| `trend` | EMA gap `(fast-slow)/slow`, saturating at ±2% | 0.40 |
| `macd` | sign + magnitude of MACD histogram | 0.15 |
| `rsi` | contrarian: oversold → bullish, overbought → bearish | 0.15 |
| `sentiment` | contrarian Fear & Greed: extreme fear → bullish | 0.15 |
| `funding` | contrarian: crowded longs (high funding) → bearish | 0.15 |

```
score = Σ(value_i · weight_i) / Σ(weight_i)         ∈ [-1, 1]
```

### Decision rules

- `score ≥ +actThreshold (0.2)` → **buy**; `score ≤ -0.2` → **sell**; else **hold**.
- `volume24hUsd < minVolumeUsd` → forced **hold** (liquidity gate).
- `conviction = min(|score| / 0.6, 1) · 100` (0–100).
- **Position size** = `min(maxTradeUsd, conviction% · availableCash)`, and only
  if `conviction ≥ minConviction`.

All parameters live in `DEFAULT_PARAMS` and are overridable for optimization.

---

## 2. Options-Implied Forecast skill

**Source:** [`src/skills/options-forecast/`](../src/skills/options-forecast/)

Forecasts **direction + an above/below threshold** for **BTC, ETH, BNB** over
**hourly / 4-hourly / daily / weekly** horizons.

- **Data** ([`fetcher.ts`](../src/skills/options-forecast/fetcher.ts)): multi-source,
  no API keys — Deribit (DVOL, Greeks, OI), Binance (IV, OI, funding), OKX/Bybit
  (OI, funding), CoinGecko / CryptoCompare (spot, realized vol). Sources are
  merged with a data-quality score.
- **Signals** ([`predictor.ts`](../src/skills/options-forecast/predictor.ts)):
  IV percentile, DVOL, put/call ratio, max pain, options flow, funding,
  liquidation imbalance, 25-delta risk reversal — each scored bullish/bearish/
  neutral with a weight and confidence, then aggregated.
- **Forecast:** an LLM (via OpenRouter) converts the aggregated signals into a
  calibrated JSON forecast (direction, target, range, confidence, threshold).
- **BNB note:** listed BNB options are thin, so BNB forecasts lean on
  futures/funding + historical-vol signals; options-specific fields degrade
  gracefully to neutral.

This skill is a strong differentiator: most entries will use raw price/indicator
data; Astraeus reads **derivatives market structure** (what option dealers and
leveraged traders are positioned for).

---

## 3. Risk guardrails (shared)

**Source:** [`src/config/risk.ts`](../src/config/risk.ts) ·
universe in [`src/config/tokens.ts`](../src/config/tokens.ts)

Every prospective trade passes `checkGuardrails()` before sizing/execution:

| Guardrail | Default | Why |
|---|---|---|
| Max drawdown halt | 20% | Stay clear of the competition DQ gate (~30%) |
| Eligible-token allowlist | 149 BEP-20 tokens | Only listed tokens score |
| Per-trade cap | $25 | Bounded blast radius |
| Daily trade / volume caps | 8 / $150 | Avoid overtrading + cost drag |
| Min trades/day | 1 | Competition eligibility rule |
| Max slippage | 100 bps | Execution quality |
| Min conviction | 60 | Skip low-edge trades |

The guardrail check returns the **first** rule that blocks a trade, so the agent
can explain exactly why it declined.

---

## 4. Backtest methodology & results

**Source:** [`src/backtest/`](../src/backtest/) · run with `bun run backtest`

The engine ([`engine.ts`](../src/backtest/engine.ts)) is a long-only spot
simulator that, per bar, asks the strategy for a decision per token, applies the
**same guardrails and sizing the live agent uses**, fills with fee + slippage,
and marks to market. Metrics mirror the Track 1 judging criteria (total return,
max drawdown, win rate).

Data is supplied as a `Series` (ordered bars of per-token signals + market
context). A reproducible synthetic generator
([`synthetic.ts`](../src/backtest/synthetic.ts)) derives EMA/RSI/MACD from a
seeded price random walk, so the backtest runs with **zero credentials**. Live
CoinMarketCap history plugs into the identical `Series` shape — the engine does
not change.

**Reference run** (`bun run backtest`, 5 assets, 720 hourly bars, seed 7):

```
total return:    +4.79%
max drawdown:    3.87%
trades:          16
win rate:        50.0%
avg trade pnl:   +1.20%
```

The low drawdown is by design — the guardrails prioritize "most profit without
blowing up", which is exactly how Track 1 PnL is scored (return gated by a
max-drawdown DQ).

> Numbers above are on **synthetic** data and exist to validate the engine and
> guardrails, not to claim live performance. Real-data backtests run once the CMC
> history loader is wired (Track 1 setup).

---

## 5. Limitations & next steps

- Replace synthetic data with a CoinMarketCap-history loader for real backtests.
- Parameter optimization / walk-forward validation over the eligible universe.
- Feed the options-forecast skill's directional calls into the composite score
  as an additional sub-signal.
- Track 1: route sized decisions through Trust Wallet Agent Kit (self-custody
  signing) and register the agent wallet on-chain before the trading window.
