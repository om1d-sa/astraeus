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
  CmcDataProvider,
  TIMEFRAMES,
  type MultiTimeframeTechnicals,
} from "../data/cmc";
import {
  runSkillBundle,
  skillsEnabled,
  skillList,
  synthesizeSkillSentiment,
  showRawSkillBundle,
  DEFAULT_RESEARCH_SKILLS,
} from "../skills/options-forecast/skill-bundle";
import {
  formatTechnicalRow,
  formatVerdict,
  parseTimeframe,
  readingsFromMulti,
  synthesizeVerdict,
  technicalSignals,
} from "../skills/research/timeframes";

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
    'Research a single token via CoinMarketCap: live price, 24h change, technicals, an overall bullish/bearish verdict with confidence and a price target, and latest news. Name a timeframe ("research X on daily", "4h", "weekly") for an expanded single-timeframe breakdown (RSI/MACD/EMA cross/price-vs-EMA/volatility); omit it for the wide 1h/4h/daily/weekly overview. Use for "research <token>", "due diligence on <token>", "analyze <token>".',

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
    // A specific timeframe ("research SIREN on daily" / "4h" / "weekly") → focus on just
    // that one with an EXPANDED, forecast-style indicator breakdown. None named → the wide
    // multi-timeframe (1h/4h/1D/1W) overview, one compact row each.
    const requestedTf = parseTimeframe(message.content?.text ?? "");

    try {
      const cmc = new CmcDataProvider();
      const techP: Promise<MultiTimeframeTechnicals> = requestedTf
        ? cmc
            .getTimeframeTechnicals(symbol, requestedTf)
            .then((tech): MultiTimeframeTechnicals => ({ [requestedTf]: tech }))
            .catch((): MultiTimeframeTechnicals => ({}))
        : cmc
            .getMultiTimeframeTechnicals(symbol)
            .catch((): MultiTimeframeTechnicals => ({}));
      const [sig, multiTech, news, dex] = await Promise.all([
        cmc.getTokenSignals([symbol]).catch(() => []),
        techP,
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

      if (requestedTf) {
        // Single timeframe: deep breakdown (RSI/MACD/EMA cross/price-vs-EMA/volatility).
        const tech = multiTech[requestedTf];
        if (tech && tech.points >= 14) {
          const rows = technicalSignals(tech, s.priceUsd).map((sigLine) => `   • ${sigLine}`);
          lines.push(`• Technicals (${requestedTf}):\n${rows.join("\n")}`);
        } else {
          lines.push(`• Technicals (${requestedTf}): not enough history yet`);
        }
      } else {
        // No timeframe named: one compact row per timeframe that has a full window.
        const shown: string[] = [];
        const tfRows = TIMEFRAMES.flatMap((tf) => {
          const tech = multiTech[tf];
          if (!tech || tech.points < 14) return [];
          shown.push(tf);
          return [`   • ${tf}: ${formatTechnicalRow(tech)}`];
        });
        if (tfRows.length)
          lines.push(`• Technicals (${shown.join("/")}):\n${tfRows.join("\n")}`);
      }

      // Optional CMC skill bundle (off unless CMC_SKILLS_ENABLED=true) → the LLM distills
      // it into a single sentiment + verdict instead of a raw dump. Falls back to raw if
      // synthesis fails. Resolve the token's on-chain contract (only when skills will run)
      // so contract-scoped skills (holder/safety/structure) analyze THIS token.
      const contract = skillsEnabled()
        ? await cmc.getTokenContract(symbol).catch(() => undefined)
        : undefined;
      const skillCtx = await runSkillBundle(
        runtime,
        skillList("RESEARCH_SKILLS", DEFAULT_RESEARCH_SKILLS),
        {
          symbol,
          ...(contract
            ? { contractToken: { symbol, platform: contract.platform, contract: contract.contract } }
            : {}),
        },
      );
      const synth = skillCtx
        ? await synthesizeSkillSentiment(runtime, skillCtx, symbol)
        : undefined;

      // Overall verdict — blend the timeframe reads (and the skill sentiment when present)
      // into a single bias / confidence / target line right under the technicals.
      const verdict = synthesizeVerdict(readingsFromMulti(multiTech), s.priceUsd, {
        skillSentiment: synth?.sentiment,
      });
      const verdictLine = formatVerdict(verdict, s.priceUsd);
      if (verdictLine) lines.push(`• Verdict: ${verdictLine}`);

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
      if (synth)
        lines.push(
          `\n• CMC skill read (${synth.sentiment >= 0 ? "+" : ""}${synth.sentiment.toFixed(2)}): ${synth.summary}`,
        );
      else if (skillCtx && showRawSkillBundle()) lines.push(`\n${skillCtx}`);
      const text = lines.join("\n");
      await callback?.({ text, actions: ["RESEARCH"] });
      return {
        text: `research ${symbol}`,
        success: true,
        values: {
          symbol,
          priceUsd: s.priceUsd,
          bias: verdict.bias,
          confidence: verdict.confidence,
          ...(verdict.targetPrice !== undefined
            ? { targetPrice: verdict.targetPrice }
            : {}),
        },
        data: { actionName: "RESEARCH", symbol, timeframe: requestedTf, verdict },
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
          text: "🔎 CAKE research (CoinMarketCap)\n• Price: …\n• Technicals (1h/4h/1D/1W): …\n• Verdict: 🟢 Bullish · confidence 72% · target $… (+4.5%)",
          actions: ["RESEARCH"],
        },
      },
    ],
    [
      { name: "{{name1}}", content: { text: "research SIREN on daily" } },
      {
        name: "Astraeus",
        content: {
          text: "🔎 SIREN research (CoinMarketCap)\n• Price: …\n• Technicals (1D):\n   • RSI14: 13 (oversold)\n   • MACD: bearish (-0.26%)\n   • EMA12 / EMA26: … (downtrend)\n   • Price vs EMA26: -2.4% (below)\n   • Volatility: 8.3% avg move/candle\n• Verdict: 🔴 Bearish · confidence …",
          actions: ["RESEARCH"],
        },
      },
    ],
  ],
};

export default researchAction;
