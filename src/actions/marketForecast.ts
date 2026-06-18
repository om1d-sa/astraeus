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

const TF_LABEL: Record<ForecastTimeframe, string> = {
  hourly: "1H",
  fourHourly: "4H",
  daily: "1D",
  weekly: "1W",
};

/** Market-cap-ish weights so the overall read leans on the larger assets. */
const WEIGHTS: Record<Asset, number> = { BTC: 0.5, ETH: 0.3, BNB: 0.2 };
const ASSETS: Asset[] = ["BTC", "ETH", "BNB"];

const dirArrow = (d: string): string =>
  d === "up" ? "▲" : d === "down" ? "▼" : "—";
const dirVal = (d: string): number => (d === "up" ? 1 : d === "down" ? -1 : 0);

function assetLine(f: PriceForecast): string {
  const p = f.prediction;
  const chg = `${p.priceChange >= 0 ? "+" : ""}${p.priceChange.toFixed(1)}%`;
  return `  • ${f.asset}: ${dirArrow(p.direction)} ${p.direction.toUpperCase()} ${(p.confidence * 100).toFixed(0)}% → $${p.targetPrice.toLocaleString()} (${chg})`;
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
    _runtime: IAgentRuntime,
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

      const forecasts = await Promise.all(
        ASSETS.map((a) => generateForecast(a, timeframe)),
      );
      const byAsset: Record<Asset, PriceForecast> = {
        BTC: forecasts[0],
        ETH: forecasts[1],
        BNB: forecasts[2],
      };

      // Weighted aggregate: score in -1..1 (weights sum to 1), confidence 0..1.
      let score = 0;
      let confidence = 0;
      for (const f of forecasts) {
        score +=
          dirVal(f.prediction.direction) *
          f.prediction.confidence *
          WEIGHTS[f.asset];
        confidence += f.prediction.confidence * WEIGHTS[f.asset];
      }
      const overall =
        score > 0.12 ? "BULLISH" : score < -0.12 ? "BEARISH" : "NEUTRAL";
      const overallArrow =
        overall === "BULLISH" ? "▲" : overall === "BEARISH" ? "▼" : "—";
      const scoreOut = Math.round(score * 100);

      const responseText =
        `Overall crypto market — ${TF_LABEL[timeframe]} — ${overallArrow} ${overall} (score ${scoreOut >= 0 ? "+" : ""}${scoreOut})\n` +
        `• Conviction: ${(confidence * 100).toFixed(0)}%\n` +
        `• Breakdown (weighted BTC 50% / ETH 30% / BNB 20%):\n` +
        `${ASSETS.map((a) => assetLine(byAsset[a])).join("\n")}\n` +
        `• Read: ${overall === "NEUTRAL" ? "majors are mixed/range-bound" : `majors lean ${overall.toLowerCase()}`} on the ${TF_LABEL[timeframe]} horizon` +
        ` (BTC ${byAsset.BTC.prediction.direction}, ETH ${byAsset.ETH.prediction.direction}, BNB ${byAsset.BNB.prediction.direction}).`;

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
