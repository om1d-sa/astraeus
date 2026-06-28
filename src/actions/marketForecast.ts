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
  generateForecast,
  type Asset,
  type ForecastTimeframe,
  type PriceForecast,
} from "../skills/options-forecast";
import { parseTimeframe } from "./forecast";
import { CmcDataProvider } from "../data/cmc";
import { fetchCmcOptionsEnrichment } from "../skills/options-forecast/enrich";
import {
  runSkillBundle,
  skillList,
  synthesizeSkillSentiment,
  showRawSkillBundle,
  DEFAULT_MARKET_SKILLS,
} from "../skills/options-forecast/skill-bundle";

const TF_LABEL: Record<ForecastTimeframe, string> = {
  hourly: "1H",
  fourHourly: "4H",
  daily: "1D",
  weekly: "1W",
};

/** Read a numeric env var, falling back when unset/blank/non-numeric. */
const numEnv = (key: string, fallback: number): number => {
  const v = process.env[key];
  const n = v !== undefined && v !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
};

/**
 * Market-cap-ish weights so the overall read leans on the larger assets.
 * Controllable via MARKET_WEIGHT_BTC/ETH/BNB (any scale — they're normalized by the
 * weight that actually resolves at blend time). Defaults 50/30/20.
 */
const assetWeights = (): Record<Asset, number> => ({
  BTC: numEnv("MARKET_WEIGHT_BTC", 50),
  ETH: numEnv("MARKET_WEIGHT_ETH", 30),
  BNB: numEnv("MARKET_WEIGHT_BNB", 20),
});
const ASSETS: Asset[] = ["BTC", "ETH", "BNB"];

const dirArrow = (d: string): string =>
  d === "up" ? "▲" : d === "down" ? "▼" : "—";
const dirVal = (d: string): number => (d === "up" ? 1 : d === "down" ? -1 : 0);

/** Compact one-liner per major — a light pointer, not the focus of the read. */
function majorLine(f: PriceForecast): string {
  const p = f.prediction;
  const chg = `${p.priceChange >= 0 ? "+" : ""}${p.priceChange.toFixed(1)}%`;
  return `${f.asset} ${dirArrow(p.direction)} ${(p.confidence * 100).toFixed(0)}% $${p.targetPrice.toLocaleString()} (${chg})`;
}

/**
 * MARKET_FORECAST — overall crypto-market directional outlook.
 *
 * Forecasts BTC, ETH and BNB on a chosen timeframe and aggregates them (weighted)
 * into a single market read (BULLISH / BEARISH / NEUTRAL). Supports a timeframe
 * (hourly/4h/daily/weekly); scope is the market as a whole rather than one asset.
 * Uses fast numeric options data only (no CMC enrichment).
 */
export const marketForecastAction: Action = {
  name: "MARKET_FORECAST",
  similes: [
    "OVERALL_MARKET",
    "MARKET_STATUS",
    "MARKET_OUTLOOK",
    "MARKET_DIRECTION",
    "CRYPTO_MARKET_FORECAST",
  ],
  description:
    'Forecast the OVERALL crypto market status (weighted across BTC/ETH/BNB) on a timeframe (hourly, 4h, daily, weekly). Use for "overall market forecast", "market status", "market outlook/direction".',

  validate: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
  ): Promise<boolean> => {
    const t = (message.content?.text ?? "").toLowerCase();
    if (!/\bmarket\b/.test(t)) return false;
    // "market overview" / explicit skill runs belong to CMC_SKILL; close/sell to CLOSE_ALL.
    if (/\b(skill|overview)\b/.test(t)) return false;
    if (/\b(close|sell|exit|flatten|liquidate)\b/.test(t)) return false;
    return /(forecast|predict|prediction|outlook|status|direction|sentiment|bullish|bearish|overall|condition|regime)/.test(
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
    const text = message.content?.text ?? "";
    const timeframe = parseTimeframe(text);

    try {
      logger.info(
        { timeframe },
        "MARKET_FORECAST: generating overall market forecast",
      );

      // Per-asset options forecasts (fast free sources, no slow options-positioning) +
      // CMC market data, all in parallel.
      const cmc = (() => {
        try {
          return new CmcDataProvider();
        } catch {
          return null;
        }
      })();
      // Source 7 (CMC options-positioning) feeds the options leg — slow (MCP),
      // so OFF by default; flip MARKET_OPTIONS_ENRICH=true to include it.
      const useSource7 =
        (process.env.MARKET_OPTIONS_ENRICH ?? "false").toLowerCase() === "true";
      const optCtxP: Promise<(string | undefined)[]> = useSource7
        ? Promise.all(
            ASSETS.map((a) => fetchCmcOptionsEnrichment(runtime, a, true)),
          )
        : Promise.resolve(ASSETS.map(() => undefined));
      const [optCtx, g, mc, news, btcTech] = await Promise.all([
        optCtxP,
        cmc
          ? cmc.getGlobalMetrics().catch(() => undefined)
          : Promise.resolve(undefined),
        cmc
          ? cmc.getMarketContext().catch(() => ({}) as { fearGreed?: number })
          : Promise.resolve({} as { fearGreed?: number }),
        cmc
          ? cmc.getLatestNews("BTC", 3).catch(() => [])
          : Promise.resolve([] as { title: string }[]),
        cmc
          ? cmc.getTechnicals("BTC").catch(() => undefined)
          : Promise.resolve(undefined),
      ]);
      // Per-asset forecasts run independently — one asset's transient failure (a
      // network blip on its LLM/data call) must NOT sink the whole market read.
      const settled = await Promise.allSettled(
        ASSETS.map((a, i) => generateForecast(a, timeframe, optCtx[i])),
      );
      const forecasts = settled
        .filter(
          (r): r is PromiseFulfilledResult<PriceForecast> =>
            r.status === "fulfilled",
        )
        .map((r) => r.value);
      const failedAssets = ASSETS.filter(
        (_, i) => settled[i].status === "rejected",
      );
      if (forecasts.length === 0) {
        const reasons = settled
          .map((r) =>
            r.status === "rejected"
              ? String(r.reason?.message ?? r.reason)
              : "",
          )
          .filter(Boolean)
          .join("; ");
        throw new Error(`all per-asset forecasts failed: ${reasons}`);
      }
      if (failedAssets.length)
        logger.warn(
          { failedAssets },
          "MARKET_FORECAST: some assets failed; degrading to the rest",
        );
      const byAsset: Partial<Record<Asset, PriceForecast>> = Object.fromEntries(
        forecasts.map((f) => [f.asset, f]),
      );

      // Options leg: weighted directional score in -1..1. Renormalize by the weight
      // that actually resolved so a missing asset doesn't deflate the blend (any
      // weight scale works — the result depends only on the BTC/ETH/BNB ratio).
      const WEIGHTS = assetWeights();
      const totalWeight = forecasts.reduce((s, f) => s + WEIGHTS[f.asset], 0);
      let optScore = 0;
      let confidence = 0;
      for (const f of forecasts) {
        optScore +=
          dirVal(f.prediction.direction) *
          f.prediction.confidence *
          WEIGHTS[f.asset];
        confidence += f.prediction.confidence * WEIGHTS[f.asset];
      }
      if (totalWeight > 0) {
        optScore /= totalWeight;
        confidence /= totalWeight;
      }

      // CMC market-sentiment leg (70%): Fear & Greed + total-cap 24h change → -1..1.
      const clamp = (x: number) => Math.max(-1, Math.min(1, x));
      const fgScore =
        mc.fearGreed !== undefined
          ? clamp((mc.fearGreed - 50) / 50)
          : undefined;
      const mcapScore =
        g?.marketCapChange24hPct !== undefined
          ? clamp(g.marketCapChange24hPct / 5)
          : undefined;
      // BTC technicals as the market-wide momentum proxy (RSI + MACD).
      const btcRsiScore =
        btcTech?.rsi14 !== undefined
          ? clamp((btcTech.rsi14 - 50) / 50)
          : undefined;
      const btcMacdScore =
        btcTech?.macd !== undefined
          ? btcTech.macd > 0
            ? 0.5
            : btcTech.macd < 0
              ? -0.5
              : 0
          : undefined;
      const cmcSignals = [fgScore, mcapScore, btcRsiScore, btcMacdScore].filter(
        (x): x is number => x !== undefined,
      );
      const cmcScore = cmcSignals.length
        ? cmcSignals.reduce((a, b) => a + b, 0) / cmcSignals.length
        : undefined;

      // CMC skill bundle (off unless CMC_SKILLS_ENABLED) → the LLM distills it into a
      // directional sentiment that ACTUALLY moves the score (third leg of the blend below).
      // If skills are off or synthesis fails, that leg simply drops out.
      const skillCtx = await runSkillBundle(
        runtime,
        skillList("MARKET_SKILLS", DEFAULT_MARKET_SKILLS),
        {},
        // Per-symbol skills fan across the majors; each skill's exact params (preview,
        // lookback, assets, …) are built per-schema by SKILL_SPECS.
        { symbols: ASSETS },
      );
      const synth = skillCtx
        ? await synthesizeSkillSentiment(
            runtime,
            skillCtx,
            "the overall crypto market",
          )
        : undefined;
      // Final score: a SINGLE weighted blend over three legs, all on the same whole-number
      // scale (defaults CMC 56 / options 24 / skill 20). Any leg that's unavailable — CMC
      // REST down, or skills off / synthesis failed — drops out and the remaining legs are
      // renormalized, so only the RATIO between the present legs matters. With all three:
      // 0.56·cmc + 0.24·opt + 0.20·skill; with skills off it collapses to a 70/30 cmc/opt
      // split (56:24); options-only if CMC is also down.
      const legs: Array<{ w: number; score: number }> = [
        { w: numEnv("MARKET_OPTIONS_WEIGHT", 24), score: optScore },
      ];
      if (cmcScore !== undefined)
        legs.push({ w: numEnv("MARKET_CMC_WEIGHT", 56), score: cmcScore });
      if (synth)
        legs.push({
          w: numEnv("MARKET_SKILL_WEIGHT", 20),
          score: synth.sentiment,
        });
      const legTotal = legs.reduce((s, l) => s + l.w, 0);
      const blended =
        legTotal > 0
          ? legs.reduce((s, l) => s + l.w * l.score, 0) / legTotal
          : optScore;
      const overall =
        blended > 0.12 ? "BULLISH" : blended < -0.12 ? "BEARISH" : "NEUTRAL";
      const overallArrow =
        overall === "BULLISH" ? "▲" : overall === "BEARISH" ? "▼" : "—";
      const scoreOut = Math.round(blended * 100);

      // The blend weights (CMC market 70% / options 30%, BTC/ETH/BNB split) are an
      // internal methodology detail — keep them OUT of the user-facing text.
      let responseText =
        `Overall crypto market — ${TF_LABEL[timeframe]} — ${overallArrow} ${overall} (score ${scoreOut >= 0 ? "+" : ""}${scoreOut})\n` +
        `• Conviction: ${(confidence * 100).toFixed(0)}%`;

      const status: string[] = [];
      if (g) {
        const chg =
          g.marketCapChange24hPct !== undefined
            ? ` (${g.marketCapChange24hPct >= 0 ? "+" : ""}${g.marketCapChange24hPct.toFixed(1)}% 24h)`
            : "";
        status.push(
          `  • Total cap $${(g.totalMarketCapUsd / 1e9).toFixed(0)}B${chg} · BTC dominance ${g.btcDominance.toFixed(1)}%`,
        );
      }
      if (mc.fearGreed !== undefined)
        status.push(`  • Fear & Greed: ${mc.fearGreed}/100`);
      if (btcTech && btcTech.points >= 14) {
        const macd =
          btcTech.macd === undefined
            ? "n/a"
            : btcTech.macd > 0
              ? `bullish (+${btcTech.macd.toFixed(1)})`
              : `bearish (${btcTech.macd.toFixed(1)})`;
        status.push(
          `  • BTC technicals (CMC daily): RSI14 ${btcTech.rsi14?.toFixed(0) ?? "n/a"}, MACD ${macd}, EMA12 ${btcTech.ema12?.toFixed(0) ?? "n/a"} vs EMA26 ${btcTech.ema26?.toFixed(0) ?? "n/a"}`,
        );
      }
      if (status.length)
        responseText += `\n• Market internals:\n${status.join("\n")}`;
      // Light pointer to the majors — single compact line so the read stays
      // market-wide rather than turning into a BTC/ETH/BNB rundown.
      const availMajors = ASSETS.filter((a) => byAsset[a]).map((a) =>
        majorLine(byAsset[a] as PriceForecast),
      );
      responseText += `\n• Majors: ${availMajors.join(" · ")}`;
      if (failedAssets.length)
        responseText += `\n• Note: ${failedAssets.join(", ")} forecast unavailable (transient data/LLM error) — read uses the rest.`;
      if (news.length)
        responseText += `\n• Latest news (CMC):\n${news.map((n) => `  • ${n.title}`).join("\n")}`;

      // CMC skill read — the LLM-synthesized signal that MOVED the score above (not a raw
      // dump). Falls back to the raw bundle only if synthesis failed.
      if (synth)
        responseText += `\n• CMC skill read (${synth.sentiment >= 0 ? "+" : ""}${synth.sentiment.toFixed(2)}): ${synth.summary}`;
      else if (skillCtx && showRawSkillBundle())
        responseText += `\n\n${skillCtx}`;

      await callback?.({ text: responseText, actions: ["MARKET_FORECAST"] });
      return {
        text: `Overall market forecast (${timeframe}): ${overall}`,
        success: true,
        values: { timeframe, overall, score: scoreOut, confidence },
        data: {
          actionName: "MARKET_FORECAST",
          timeframe,
          overall,
          score: scoreOut,
          byAsset,
        },
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error({ error: msg }, "MARKET_FORECAST failed");
      await callback?.({
        text: `Could not generate the overall market forecast: ${msg}`,
        error: true,
      });
      return {
        text: "Market forecast failed",
        success: false,
        error: error instanceof Error ? error : new Error(msg),
      };
    }
  },

  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "what's the overall market status on the daily?" },
      },
      {
        name: "Astraeus",
        content: {
          text: "Overall crypto market — 1D — ▲ BULLISH (score +28) …",
          actions: ["MARKET_FORECAST"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "forecast the whole market for the week" },
      },
      {
        name: "Astraeus",
        content: {
          text: "Overall crypto market — 1W — ▼ BEARISH …",
          actions: ["MARKET_FORECAST"],
        },
      },
    ],
  ],
};

export default marketForecastAction;
