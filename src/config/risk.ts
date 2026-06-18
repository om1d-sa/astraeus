/**
 * Risk guardrails for the Astraeus trading agent.
 *
 * The BNB Hack Track 1 scoring explicitly rewards hard guardrails (drawdown caps,
 * token allowlists, per-trade and daily limits, slippage protection) and a
 * max-drawdown DQ gate (e.g. blow past ~30% and you are disqualified regardless
 * of PnL). These limits are read from the environment so they can be tuned
 * without code changes, and applied by the trading loop BEFORE any execution.
 *
 * Defaults are deliberately conservative — the goal is "most profit without
 * blowing up", and a disqualified agent scores nothing.
 */

const num = (key: string, fallback: number): number => {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export interface RiskConfig {
  /** Hard stop. If realized drawdown from peak exceeds this %, halt all trading. Keep below the competition DQ threshold. */
  maxDrawdownPct: number;
  /** Largest single trade, in USD notional. */
  maxTradeUsd: number;
  /** Max number of trades the agent may place per UTC day. */
  maxTradesPerDay: number;
  /** Total USD notional the agent may trade per UTC day. */
  maxDailyVolumeUsd: number;
  /** Minimum trades/day required to stay eligible (competition rule: >= 1). */
  minTradesPerDay: number;
  /** Max acceptable slippage on a swap, in basis points (100 bps = 1%). */
  maxSlippageBps: number;
  /** Minimum LLM conviction (0-100) required to act. Below this → hold. */
  minConviction: number;
  /** Keep at least this much of the portfolio in stables as dry powder (%). */
  minCashReservePct: number;
}

export function getRiskConfig(): RiskConfig {
  return {
    maxDrawdownPct: num('RISK_MAX_DRAWDOWN_PCT', 20), // DQ gate is ~30%; stay clear of it
    maxTradeUsd: num('RISK_MAX_TRADE_USD', 25),
    maxTradesPerDay: num('RISK_MAX_TRADES_PER_DAY', 8),
    maxDailyVolumeUsd: num('RISK_MAX_DAILY_VOLUME_USD', 150),
    minTradesPerDay: num('RISK_MIN_TRADES_PER_DAY', 1), // competition requires >= 1/day
    maxSlippageBps: num('RISK_MAX_SLIPPAGE_BPS', 100), // 1%
    minConviction: num('RISK_MIN_CONVICTION', 60),
    minCashReservePct: num('RISK_MIN_CASH_RESERVE_PCT', 20),
  };
}

/** Result of a pre-trade guardrail check. */
export interface GuardrailDecision {
  allowed: boolean;
  /** Which guardrail blocked the trade (for transparent logging), if any. */
  reason?: string;
}

/** Context the guardrail check needs about current state and the proposed trade. */
export interface GuardrailContext {
  conviction: number; // 0-100
  tradeUsd: number;
  currentDrawdownPct: number; // realized drawdown from peak, %
  tradesToday: number;
  volumeTodayUsd: number;
  tokenSymbol: string;
  isTokenEligible: boolean;
}

/**
 * Pure pre-trade gate. Returns the FIRST guardrail that blocks the trade so the
 * agent can explain exactly why it declined. Call this before signing anything.
 */
export function checkGuardrails(ctx: GuardrailContext, cfg: RiskConfig = getRiskConfig()): GuardrailDecision {
  if (ctx.currentDrawdownPct >= cfg.maxDrawdownPct) {
    return { allowed: false, reason: `drawdown ${ctx.currentDrawdownPct.toFixed(1)}% >= cap ${cfg.maxDrawdownPct}%` };
  }
  if (!ctx.isTokenEligible) {
    return { allowed: false, reason: `${ctx.tokenSymbol} not on eligible-token allowlist` };
  }
  if (ctx.conviction < cfg.minConviction) {
    return { allowed: false, reason: `conviction ${ctx.conviction} < min ${cfg.minConviction}` };
  }
  if (ctx.tradeUsd > cfg.maxTradeUsd) {
    return { allowed: false, reason: `trade $${ctx.tradeUsd} > per-trade cap $${cfg.maxTradeUsd}` };
  }
  if (ctx.tradesToday >= cfg.maxTradesPerDay) {
    return { allowed: false, reason: `daily trade count ${ctx.tradesToday} >= cap ${cfg.maxTradesPerDay}` };
  }
  if (ctx.volumeTodayUsd + ctx.tradeUsd > cfg.maxDailyVolumeUsd) {
    return { allowed: false, reason: `daily volume would exceed cap $${cfg.maxDailyVolumeUsd}` };
  }
  return { allowed: true };
}
