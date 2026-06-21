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
  DEFAULT_LIQUIDATION_SKILLS,
} from "../skills/options-forecast/skill-bundle";

/**
 * LIQUIDATION_ANALYSIS — market-wide liquidation/cascade read, useful after a sharp
 * move: cascade risk, liquidation clusters, short-squeeze fuel, volatility squeeze
 * release, and large-trade liquidity risk — via CMC skills.
 */
export const liquidationAction: Action = {
  name: "LIQUIDATION_ANALYSIS",
  similes: [
    "LIQUIDATION_RISK",
    "LIQUIDATION_CASCADE",
    "CASCADE_RISK",
    "SHORT_SQUEEZE",
    "AFTER_SHARP_MOVE",
  ],
  description:
    'Analyze market-wide LIQUIDATION / cascade risk after a sharp move (cascade risk, liquidation clusters, short-squeeze fuel) via CMC skills. Use for "liquidation analysis", "cascade risk", "liquidation after the dump/pump".',

  validate: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
  ): Promise<boolean> => {
    const t = (message.content?.text ?? "").toLowerCase();
    return (
      /\b(liquidation|cascade|short[\s-]?squeeze|squeeze)\b/.test(t) ||
      (/\bafter\b/.test(t) && /\b(sharp move|dump|pump|crash|spike)\b/.test(t))
    );
  },

  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State | undefined,
    _options: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    try {
      await callback?.({
        text: "💥 Analyzing market-wide liquidation/cascade risk via CMC skills — this can take a minute…",
      });
      const skillCtx = await runSkillBundle(
        runtime,
        skillList("LIQUIDATION_SKILLS", DEFAULT_LIQUIDATION_SKILLS),
        {},
        // force-run even when auto-enrichment is off; per-symbol skills fan across the majors.
        { force: true, symbols: ["BTC", "ETH", "BNB"] },
      );
      const body =
        skillCtx ??
        "No CMC skill analysis returned (skills unavailable or timed out).";
      const responseText = `💥 Liquidation / cascade analysis\n\n${body}`;
      await callback?.({
        text: responseText,
        actions: ["LIQUIDATION_ANALYSIS"],
      });
      return {
        text: "liquidation analyzed",
        success: true,
        data: { actionName: "LIQUIDATION_ANALYSIS" },
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error({ error: msg }, "LIQUIDATION_ANALYSIS failed");
      await callback?.({
        text: `Liquidation analysis failed: ${msg}`,
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
        content: { text: "liquidation analysis after this dump" },
      },
      {
        name: "Astraeus",
        content: {
          text: "💥 Liquidation / cascade analysis …",
          actions: ["LIQUIDATION_ANALYSIS"],
        },
      },
    ],
  ],
};

export default liquidationAction;
