import {
  type Action,
  type ActionResult,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
  logger,
} from "@elizaos/core";
import { CmcDataProvider } from "../data/cmc";
import {
  runSkillBundle,
  skillList,
  DEFAULT_TRENDING_SKILLS,
} from "../skills/options-forecast/skill-bundle";

/**
 * TRENDING — top trending tokens by CoinMarketCap market activity.
 * Read-only CMC data; useful for spotting what's hot before considering a trade.
 */
export const trendingAction: Action = {
  name: "TRENDING",
  similes: ["TRENDING_TOKENS", "WHATS_HOT", "HOT_COINS", "MOVERS", "GAINERS"],
  description:
    'List the top trending tokens by CoinMarketCap market activity. Use for "trending", "what\'s hot", "top movers".',

  validate: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
  ): Promise<boolean> => {
    const t = (message.content?.text ?? "").toLowerCase();
    return /\b(trending|what'?s hot|hot coins?|top movers?|biggest movers?|gainers?)\b/.test(
      t,
    );
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined,
    _options: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    try {
      const limitMatch = (message.content?.text ?? "").match(/\b(\d{1,2})\b/);
      const limit = Math.min(Math.max(Number(limitMatch?.[1] ?? 10), 1), 20);
      const cmc = new CmcDataProvider();
      const items = await cmc.getTrending(limit);
      if (items.length === 0) {
        await callback?.({
          text: "No trending data returned by CoinMarketCap.",
          actions: ["TRENDING"],
        });
        return { text: "none", success: true, values: { count: 0 } };
      }
      const lines = items.map((t, i) => {
        const chg =
          t.change24hPct !== undefined
            ? ` (${t.change24hPct >= 0 ? "+" : ""}${t.change24hPct.toFixed(1)}% 24h)`
            : "";
        const px =
          t.priceUsd !== undefined ? ` $${t.priceUsd.toLocaleString()}` : "";
        return `  ${i + 1}. ${t.symbol} — ${t.name}${px}${chg}`;
      });
      let text = `🔥 Trending on CoinMarketCap:\n${lines.join("\n")}`;
      // Optional CMC skill bundle (off unless CMC_SKILLS_ENABLED=true).
      const skillCtx = await runSkillBundle(
        runtime,
        skillList("TRENDING_SKILLS", DEFAULT_TRENDING_SKILLS),
        { preview: true },
      );
      if (skillCtx) text += `\n\n${skillCtx}`;
      await callback?.({ text, actions: ["TRENDING"] });
      return {
        text: `trending: ${items.length}`,
        success: true,
        values: { count: items.length },
        data: { actionName: "TRENDING", items },
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error({ error: msg }, "TRENDING failed");
      await callback?.({
        text: `Could not fetch trending tokens: ${msg}`,
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
      { name: "{{name1}}", content: { text: "what's trending?" } },
      {
        name: "Astraeus",
        content: {
          text: "🔥 Trending on CoinMarketCap:\n  1. … ",
          actions: ["TRENDING"],
        },
      },
    ],
  ],
};

export default trendingAction;
