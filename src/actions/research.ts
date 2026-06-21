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
  synthesizeSkillSentiment,
  DEFAULT_RESEARCH_SKILLS,
} from "../skills/options-forecast/skill-bundle";

// English filler words that look like symbols but are never the token here. Note:
// "ON"/"IN" are intentionally NOT here (they're real CMC tokens) — the regex below
// instead treats a leading "on/about/the/…" as filler so "research on CAKE" → CAKE,
// while "research ON" (no token after) still resolves to the ON token.
const STOPWORDS = new Set([
  "THE", "AND", "FOR", "ABOUT", "WITH", "FROM", "THIS", "THAT", "WHAT", "WHATS",
  "PLEASE", "TOKEN", "COIN", "CRYPTO", "PRICE", "RESEARCH", "FUNDAMENTALS",
  "TOKENOMICS", "ANALYZE", "DUE", "DILIGENCE",
]);

/** Pull a token symbol from the message (e.g. "research CAKE", "$BNB", "dd on AAVE",
 *  "research on CAKE" → CAKE — a leading "on/about/the/for/of" is treated as filler). */
export function parseSymbol(text: string): string | undefined {
  const patterns = [
    /\b(?:research|dd|due[\s-]?diligence|fundamentals|tokenomics|analyze)\s+(?:on|about|the|for|of)?\s*\$?([A-Za-z]{2,12})\b/i,
    /\$([A-Za-z]{2,12})\b/,
    /\b([A-Z]{2,6})\b/,
  ];
  for (const re of patterns) {
    const sym = text.match(re)?.[1]?.toUpperCase();
    if (sym && !STOPWORDS.has(sym)) return sym;
  }
  return undefined;
}

/**
 * RESEARCH — single-token due diligence from CoinMarketCap: live quote + 24h move,
 * CMC technicals (RSI/MACD/EMA), on-chain DEX pairs (CMC DEX API), and latest news.
 * A lightweight "Crypto Research" card.
 */
export const researchAction: Action = {
  name: "RESEARCH",
  similes: [
    "TOKEN_RESEARCH",
    "DUE_DILIGENCE",
    "CRYPTO_RESEARCH",
    "ANALYZE_TOKEN",
    "DD",
  ],
  description:
    'Research a single token via CoinMarketCap: live price, 24h change, technicals (RSI/MACD/EMA) and latest news. Use for "research <token>", "due diligence on <token>", "analyze <token>".',

  validate: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
  ): Promise<boolean> => {
    const t = (message.content?.text ?? "").toLowerCase();
    return (
      /\b(research|due[\s-]?diligence|\bdd\b|fundamentals|tokenomics|analyze)\b/.test(
        t,
      ) && parseSymbol(message.content?.text ?? "") !== undefined
    );
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined,
    _options: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const symbol = parseSymbol(message.content?.text ?? "");
    if (!symbol) {
      await callback?.({
        text: 'Tell me which token — e.g. "research CAKE".',
        error: true,
      });
      return { text: "no symbol", success: false };
    }
    try {
      const cmc = new CmcDataProvider();
      const [sig, tech, news, dex] = await Promise.all([
        cmc.getTokenSignals([symbol]).catch(() => []),
        cmc.getTechnicals(symbol).catch(() => undefined),
        cmc.getLatestNews(symbol, 3).catch(() => []),
        cmc.getDexPairs(symbol, 3).catch(() => []),
      ]);
      const s = sig[0];
      if (!s || s.priceUsd <= 0) {
        await callback?.({
          text: `Couldn't find CoinMarketCap data for ${symbol}.`,
          error: true,
        });
        return { text: "not found", success: false };
      }
      const lines = [`🔎 ${symbol} research (CoinMarketCap)`];
      lines.push(
        `• Price: $${s.priceUsd.toLocaleString()}${s.change24hPct !== undefined ? ` (${s.change24hPct >= 0 ? "+" : ""}${s.change24hPct.toFixed(1)}% 24h)` : ""}`,
      );
      if (s.volume24hUsd)
        lines.push(`• 24h volume: $${(s.volume24hUsd / 1e6).toFixed(1)}M`);
      if (tech && tech.points >= 14) {
        const macd =
          tech.macd === undefined
            ? "n/a"
            : tech.macd > 0
              ? `bullish (+${tech.macd.toFixed(1)})`
              : `bearish (${tech.macd.toFixed(1)})`;
        lines.push(
          `• Technicals (daily): RSI14 ${tech.rsi14?.toFixed(0) ?? "n/a"}, MACD ${macd}`,
        );
      }
      if (dex.length) {
        const top = dex.map((d) => {
          const liq =
            d.liquidityUsd !== undefined
              ? ` liq $${(d.liquidityUsd / 1e3).toFixed(0)}k`
              : "";
          const vol =
            d.volume24hUsd !== undefined
              ? ` · vol $${(d.volume24hUsd / 1e3).toFixed(0)}k`
              : "";
          return `   • ${d.pair}${d.dex ? ` (${d.dex})` : ""}:${liq}${vol}`;
        });
        lines.push(
          `• DEX pairs on ${dex[0].network} (CMC DEX API):\n${top.join("\n")}`,
        );
      }
      if (news.length)
        lines.push(`• News:\n${news.map((n) => `   • ${n.title}`).join("\n")}`);
      // Optional CMC skill bundle (off unless CMC_SKILLS_ENABLED=true) → the LLM distills
      // it into a single verdict instead of a raw dump. Falls back to raw if synthesis fails.
      const skillCtx = await runSkillBundle(
        runtime,
        skillList("RESEARCH_SKILLS", DEFAULT_RESEARCH_SKILLS),
        { symbol },
      );
      if (skillCtx) {
        const synth = await synthesizeSkillSentiment(runtime, skillCtx, symbol);
        lines.push(
          synth
            ? `\n• CMC skill read (${synth.sentiment >= 0 ? "+" : ""}${synth.sentiment.toFixed(2)}): ${synth.summary}`
            : `\n${skillCtx}`,
        );
      }
      const text = lines.join("\n");
      await callback?.({ text, actions: ["RESEARCH"] });
      return {
        text: `research ${symbol}`,
        success: true,
        values: { symbol, priceUsd: s.priceUsd },
        data: { actionName: "RESEARCH", symbol },
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error({ error: msg }, "RESEARCH failed");
      await callback?.({
        text: `Research failed for ${symbol}: ${msg}`,
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
      { name: "{{name1}}", content: { text: "research CAKE" } },
      {
        name: "Astraeus",
        content: {
          text: "🔎 CAKE research (CoinMarketCap)\n• Price: …",
          actions: ["RESEARCH"],
        },
      },
    ],
  ],
};

export default researchAction;
