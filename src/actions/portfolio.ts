import {
  type Action,
  type ActionResult,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
  logger,
} from "@elizaos/core";
import {
  runSkillBundle,
  skillList,
  synthesizeSkillReport,
  showRawSkillBundle,
  DEFAULT_PORTFOLIO_SKILLS,
} from "../skills/options-forecast/skill-bundle";

interface Holding {
  symbol: string;
  pct: number;
}

/** Parse "40% BTC, 30% ETH, 30% USDT" or "BTC 40, ETH 30" into holdings. */
function parsePortfolio(text: string): Holding[] {
  const out: Holding[] = [];
  const re =
    /([A-Za-z]{2,10})\s*[:=]?\s*(\d{1,3}(?:\.\d+)?)\s*%|(\d{1,3}(?:\.\d+)?)\s*%\s*([A-Za-z]{2,10})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const symbol = (m[1] ?? m[4] ?? "").toUpperCase();
    const pct = Number(m[2] ?? m[3]);
    if (symbol && symbol !== "PCT" && Number.isFinite(pct))
      out.push({ symbol, pct });
  }
  return out;
}

/**
 * PORTFOLIO_ANALYSIS — risk-reduction review of a user-supplied portfolio via CMC
 * skills (rebalance plans, options-greek exposure, PnL-driver buckets, derivatives
 * risk). The user provides holdings + percentages.
 */
export const portfolioAction: Action = {
  name: "PORTFOLIO_ANALYSIS",
  similes: [
    "ANALYZE_PORTFOLIO",
    "PORTFOLIO_RISK",
    "REBALANCE",
    "PORTFOLIO_REVIEW",
    "REDUCE_PORTFOLIO_RISK",
  ],
  description:
    'Analyze a crypto portfolio for RISK REDUCTION (rebalance, greeks, PnL drivers) via CMC skills. Provide holdings with percentages, e.g. "portfolio analysis: 40% BTC, 30% ETH, 30% USDT".',

  validate: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
  ): Promise<boolean> => {
    const t = (message.content?.text ?? "").toLowerCase();
    // Second group is intent STEMS (analy→analyse/analysis, rebalanc→rebalance), so
    // it must NOT be \b-bounded on the right or "analysis"/"rebalance" won't match.
    return (
      /\b(portfolio|rebalance|allocation|holdings)\b/.test(t) &&
      /(analy|risk|review|rebalanc|reduce|assess)/.test(t)
    );
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined,
    _options: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const text = message.content?.text ?? "";
    const holdings = parsePortfolio(text);
    if (holdings.length === 0) {
      await callback?.({
        text: 'Share your portfolio with percentages — e.g. "portfolio analysis: 40% BTC, 30% ETH, 30% USDT".',
        error: true,
      });
      return { text: "no portfolio", success: false };
    }
    const summary = holdings.map((h) => `${h.symbol} ${h.pct}%`).join(", ");
    try {
      // NO intermediate "analyzing…" callback. ElizaOS buffers every action callback() and
      // flushes them all at the END with the SAME responseId (processActions →
      // storageCallback), so a progress note never shows live AND it claims message-id=R
      // first — the final report then re-uses id=R and the GUI dedups it, leaving the result
      // invisible until a manual Ctrl+R. One final callback (below) broadcasts as a fresh
      // message that renders live; the "thinking" indicator covers the ~1 min wait.
      const skillCtx = await runSkillBundle(
        runtime,
        skillList("PORTFOLIO_SKILLS", DEFAULT_PORTFOLIO_SKILLS),
        { portfolio: holdings, holdings, focus: "risk_reduction" },
        { force: true },
      );
      // Distill the raw skill bundle into a clean trader briefing; fall back to the raw
      // dump on synthesis failure, or show raw when CMC_SKILLS_SHOW_RAW=true.
      let body =
        skillCtx ??
        "No CMC skill analysis returned (skills unavailable or timed out). Risk tips: trim concentrated positions, hold a stable buffer, and hedge majors.";
      if (skillCtx && !showRawSkillBundle()) {
        const briefing = await synthesizeSkillReport(
          runtime,
          skillCtx,
          `a crypto spot portfolio (${summary}) — risk reduction`,
        );
        if (briefing) body = briefing;
      }
      const responseText = `📊 Portfolio risk analysis — ${summary}\n\n${body}`;
      await callback?.({ text: responseText, actions: ["PORTFOLIO_ANALYSIS"] });
      return {
        text: "portfolio analyzed",
        success: true,
        values: { holdings: holdings.length },
        data: { actionName: "PORTFOLIO_ANALYSIS", holdings },
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error({ error: msg }, "PORTFOLIO_ANALYSIS failed");
      await callback?.({
        text: `Portfolio analysis failed: ${msg}`,
        error: true,
      });
      return {
        text: "error",
        success: false,
        error: error instanceof Error ? error : new Error(msg),
      };
    }
  },

  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "portfolio analysis: 50% BTC, 30% ETH, 20% USDT" },
      },
      {
        name: "Astraeus",
        content: {
          text: "📊 Portfolio risk analysis — BTC 50%, ETH 30%, USDT 20% …",
          actions: ["PORTFOLIO_ANALYSIS"],
        },
      },
    ],
  ],
};

export default portfolioAction;
