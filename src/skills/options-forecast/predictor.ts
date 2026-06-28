/**
 * Price Predictor (options-forecast skill)
 * Uses options-market data + an LLM to generate BTC/ETH/BNB directional price forecasts.
 */

import {
  Asset,
  ForecastTimeframe,
  OptionsData,
  OptionsSignal,
  PriceForecast,
  PricePrediction,
} from "./types";
import { fetchOptionsData } from "./fetcher";
import {
  MODELS,
  getOpenRouterHeaders,
  OPENROUTER_CONFIG,
} from "../../config/models";

const num = (key: string, fallback: number): number => {
  const v = process.env[key];
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
};

const sleep = (ms: number): Promise<void> =>
  new Promise((res) => setTimeout(res, ms));

/**
 * Parse a JSON object out of an LLM response that may be (a) wrapped in a
 * ```json … ``` markdown fence, and/or (b) truncated by max_tokens mid-value —
 * a common failure when a verbose `reasoning` string (the last field) runs long.
 *
 * Three tiers, returning the first that parses:
 *   1. A complete, balanced `{…}` block (the normal case).
 *   2. Repair: close an open string + any open braces (drops a trailing dangling
 *      escape / empty key). Preserves a reasoning value cut off mid-sentence.
 *   3. Fallback: keep only complete top-level pairs up to the last `depth === 1`
 *      comma, dropping a partial trailing pair JSON.parse can't accept (e.g. a
 *      reasoning string containing a raw newline). Since every numeric forecast
 *      field precedes `reasoning`, the forecast survives even if reasoning is lost.
 *
 * Returns null only when there is no usable `{` at all. `repaired` is set true
 * when tier 2/3 salvaged a truncated response, so the caller can log it.
 */
function parseLooseJson(raw: string): {
  value: Record<string, unknown>;
  repaired: boolean;
} | null {
  // Strip a leading ```json / ``` fence and any trailing fence.
  const text = raw
    .replace(/```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();

  const start = text.indexOf("{");
  if (start === -1) return null;

  const tryParse = (s: string): Record<string, unknown> | null => {
    try {
      const v = JSON.parse(s);
      return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };

  // Tier 1: a complete, balanced object is present.
  const balanced = text.match(/\{[\s\S]*\}/);
  if (balanced) {
    const ok = tryParse(balanced[0]);
    if (ok) return { value: ok, repaired: false };
  }

  // Single scan from the first `{`, tracking string/escape/brace depth and the
  // index of the last top-level (`depth === 1`) comma — the boundary after the
  // last fully-complete key/value pair.
  let depth = 0;
  let inString = false;
  let escaped = false;
  let lastTopComma = -1;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      if (inString) escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (ch === "," && depth === 1) lastTopComma = i;
  }

  // Tier 2: close an open string + any open braces.
  let repaired = text.slice(start);
  if (escaped) repaired = repaired.slice(0, -1); // lone trailing backslash
  if (inString) repaired += '"';
  // Drop a dangling key with no value yet, e.g. `… , "reasoning":`.
  repaired = repaired.replace(/,\s*"[^"]*"\s*:\s*"?$/, "");
  if (depth > 0) repaired += "}".repeat(depth);
  const tier2 = tryParse(repaired);
  if (tier2) return { value: tier2, repaired: true };

  // Tier 3: keep only the complete top-level pairs and close.
  if (lastTopComma > start) {
    const tier3 = tryParse(text.slice(start, lastTopComma) + "}");
    if (tier3) return { value: tier3, repaired: true };
  }

  return null;
}

// Timeframe configurations
const TIMEFRAME_CONFIG: Record<
  ForecastTimeframe,
  { label: string; hours: number; volatilityMultiplier: number }
> = {
  hourly: { label: "1 hour", hours: 1, volatilityMultiplier: 0.1 },
  fourHourly: { label: "4 hours", hours: 4, volatilityMultiplier: 0.2 },
  daily: { label: "24 hours", hours: 24, volatilityMultiplier: 0.5 },
  weekly: { label: "7 days", hours: 168, volatilityMultiplier: 1.0 },
};

// ========== SIGNAL EXTRACTION ==========

function extractSignals(data: OptionsData): OptionsSignal[] {
  const signals: OptionsSignal[] = [];

  // 1. IV Signal
  if (data.iv.current > 0) {
    const ivPercentile = data.iv.percentile;
    let ivInterpretation: "bullish" | "bearish" | "neutral" = "neutral";

    // High IV often precedes big moves, low IV suggests consolidation
    if (ivPercentile > 80) {
      ivInterpretation = "neutral"; // High IV = uncertainty
    } else if (ivPercentile < 20) {
      ivInterpretation = "bullish"; // Low IV often precedes breakouts
    }

    signals.push({
      indicator: "IV Percentile",
      value: ivPercentile,
      interpretation: ivInterpretation,
      weight: num("SIGNAL_WEIGHT_IV", 0.15),
      confidence: 0.7,
      source: "deribit",
    });
  }

  // 2. DVOL Signal (Deribit Volatility Index)
  if (data.iv.dvol && data.iv.dvol > 0) {
    const dvol = data.iv.dvol;
    let dvolInterpretation: "bullish" | "bearish" | "neutral" = "neutral";

    if (dvol < 40) {
      dvolInterpretation = "bullish"; // Low volatility often precedes rallies
    } else if (dvol > 80) {
      dvolInterpretation = "bearish"; // High vol = fear
    }

    signals.push({
      indicator: "DVOL Index",
      value: dvol,
      interpretation: dvolInterpretation,
      weight: num("SIGNAL_WEIGHT_DVOL", 0.12),
      confidence: 0.75,
      source: "deribit",
    });
  }

  // 3. Put/Call Ratio Signal
  if (data.openInterest.putCallRatio > 0) {
    const pcr = data.openInterest.putCallRatio;
    let pcrInterpretation: "bullish" | "bearish" | "neutral" = "neutral";

    // Contrarian indicator: high put/call = excessive fear = bullish
    if (pcr > 1.2) {
      pcrInterpretation = "bullish";
    } else if (pcr < 0.7) {
      pcrInterpretation = "bearish";
    }

    signals.push({
      indicator: "Put/Call Ratio",
      value: pcr.toFixed(2),
      interpretation: pcrInterpretation,
      weight: num("SIGNAL_WEIGHT_PCR", 0.15),
      confidence: 0.65,
      source: "deribit",
    });
  }

  // 4. Max Pain Signal
  if (data.maxPain.strikePrice > 0 && data.spotPrice > 0) {
    const distancePercent = data.maxPain.distanceFromSpot;
    let maxPainInterpretation: "bullish" | "bearish" | "neutral" = "neutral";

    // Price tends to gravitate toward max pain near expiry
    if (distancePercent > 5) {
      maxPainInterpretation = "bullish"; // Spot below max pain
    } else if (distancePercent < -5) {
      maxPainInterpretation = "bearish"; // Spot above max pain
    }

    signals.push({
      indicator: "Max Pain Distance",
      value: `${distancePercent.toFixed(1)}%`,
      interpretation: maxPainInterpretation,
      weight: num("SIGNAL_WEIGHT_MAXPAIN", 0.1),
      confidence: 0.6,
      source: "deribit",
    });
  }

  // 5. Options Flow Signal
  if (data.flow.netPremium !== 0) {
    signals.push({
      indicator: "Net Options Flow",
      value: data.flow.sentiment,
      interpretation: data.flow.sentiment,
      weight: num("SIGNAL_WEIGHT_FLOW", 0.15),
      confidence: 0.7,
      source: "deribit",
    });
  }

  // 6. Funding Rate Signal
  if (data.futures.fundingRate !== 0) {
    const fr = data.futures.fundingRate;
    let frInterpretation: "bullish" | "bearish" | "neutral" = "neutral";

    // Extreme funding = contrarian signal
    if (fr > 0.01) {
      frInterpretation = "bearish"; // Overleveraged longs
    } else if (fr < -0.01) {
      frInterpretation = "bullish"; // Overleveraged shorts
    } else if (fr > 0) {
      frInterpretation = "bullish"; // Normal bullish bias
    } else {
      frInterpretation = "bearish";
    }

    signals.push({
      indicator: "Funding Rate",
      value: `${(fr * 100).toFixed(3)}%`,
      interpretation: frInterpretation,
      weight: num("SIGNAL_WEIGHT_FUNDING", 0.12),
      confidence: 0.65,
      source: "binance",
    });
  }

  // 7. Liquidation Imbalance Signal
  const liqLongs = data.futures.liquidations24h.longs;
  const liqShorts = data.futures.liquidations24h.shorts;
  if (liqLongs > 0 || liqShorts > 0) {
    const total = liqLongs + liqShorts;
    const longPercent = (liqLongs / total) * 100;
    let liqInterpretation: "bullish" | "bearish" | "neutral" = "neutral";

    if (longPercent > 65) {
      liqInterpretation = "bearish"; // Many longs liquidated = downtrend
    } else if (longPercent < 35) {
      liqInterpretation = "bullish"; // Many shorts liquidated = uptrend
    }

    signals.push({
      indicator: "Liquidation Ratio",
      value: `${longPercent.toFixed(0)}% longs`,
      interpretation: liqInterpretation,
      weight: num("SIGNAL_WEIGHT_LIQUIDATION", 0.1),
      confidence: 0.6,
      source: "binance",
    });
  }

  // 8. IV Skew Signal
  if (data.volSurface.riskReversal !== 0) {
    const rr = data.volSurface.riskReversal;
    let rrInterpretation: "bullish" | "bearish" | "neutral" = "neutral";

    // Positive skew = calls more expensive = bullish sentiment
    if (rr > 5) {
      rrInterpretation = "bullish";
    } else if (rr < -5) {
      rrInterpretation = "bearish";
    }

    signals.push({
      indicator: "25D Risk Reversal",
      value: `${rr.toFixed(1)}%`,
      interpretation: rrInterpretation,
      weight: num("SIGNAL_WEIGHT_RISK_REVERSAL", 0.11),
      confidence: 0.7,
      source: "deribit",
    });
  }

  return signals;
}

// ========== AGGREGATE SIGNALS ==========

function aggregateSignals(signals: OptionsSignal[]): {
  overall: "bullish" | "bearish" | "neutral";
  score: number;
  confidence: number;
} {
  if (signals.length === 0) {
    return { overall: "neutral", score: 0, confidence: 0 };
  }

  let weightedScore = 0;
  let totalWeight = 0;
  let totalConfidence = 0;

  for (const signal of signals) {
    const directionValue =
      signal.interpretation === "bullish"
        ? 1
        : signal.interpretation === "bearish"
          ? -1
          : 0;

    weightedScore += directionValue * signal.weight * signal.confidence;
    totalWeight += signal.weight;
    totalConfidence += signal.confidence * signal.weight;
  }

  // Normalize score to -100 to 100
  const normalizedScore =
    totalWeight > 0 ? (weightedScore / totalWeight) * 100 : 0;
  const avgConfidence = totalWeight > 0 ? totalConfidence / totalWeight : 0;

  let overall: "bullish" | "bearish" | "neutral" = "neutral";
  if (normalizedScore > 15) {
    overall = "bullish";
  } else if (normalizedScore < -15) {
    overall = "bearish";
  }

  return {
    overall,
    score: Math.round(normalizedScore),
    confidence: avgConfidence,
  };
}

// ========== LLM FORECAST GENERATION ==========

async function generateLLMForecast(
  asset: Asset,
  timeframe: ForecastTimeframe,
  data: OptionsData,
  signals: OptionsSignal[],
  sentiment: { overall: string; score: number; confidence: number },
  extraContext?: string,
): Promise<{ prediction: PricePrediction; reasoning: string }> {
  const config = TIMEFRAME_CONFIG[timeframe];

  // Supplementary-context weighting hints handed to the LLM. Env-controllable so the
  // emphasis can be tuned without a code change (defaults 50/30/20 — options &
  // derivatives / technicals / ETF-flow & other paid context).
  const wOptions = num("FORECAST_WEIGHT_OPTIONS", 50);
  const wTechnicals = num("FORECAST_WEIGHT_TECHNICALS", 30);
  const wEtf = num("FORECAST_WEIGHT_ETF", 20);

  // Build prompt with options data
  const prompt = `You are an expert options-market analyst providing directional price predictions with an explicit above/below threshold view.

CURRENT ${asset} MARKET DATA:
- Spot Price: $${data.spotPrice.toLocaleString()}
- Implied Volatility: ${data.iv.current.toFixed(1)}% (Percentile: ${data.iv.percentile}%)
${data.iv.dvol ? `- DVOL Index: ${data.iv.dvol.toFixed(1)}` : ""}
- Put/Call Ratio: ${data.openInterest.putCallRatio.toFixed(2)}
- Open Interest: Calls ${data.openInterest.calls.toLocaleString()}, Puts ${data.openInterest.puts.toLocaleString()}
${data.maxPain.strikePrice > 0 ? `- Max Pain: $${data.maxPain.strikePrice.toLocaleString()} (${data.maxPain.distanceFromSpot.toFixed(1)}% from spot)` : ""}
- Options Flow Sentiment: ${data.flow.sentiment}
- Funding Rate: ${(data.futures.fundingRate * 100).toFixed(3)}%
- 24h Liquidations: Longs $${data.futures.liquidations24h.longs.toLocaleString()}, Shorts $${data.futures.liquidations24h.shorts.toLocaleString()}

AGGREGATED SIGNALS:
${signals.map((s) => `- ${s.indicator}: ${s.value} (${s.interpretation}, confidence: ${(s.confidence * 100).toFixed(0)}%)`).join("\n")}

OVERALL SENTIMENT: ${sentiment.overall.toUpperCase()} (Score: ${sentiment.score}, Confidence: ${(sentiment.confidence * 100).toFixed(0)}%)
${extraContext ? `\nSUPPLEMENTARY CONTEXT (CoinMarketCap Agent Hub / paid sources). IMPORTANT WEIGHTING (internal only): weight the OPTIONS & DERIVATIVES data above ~${wOptions}%, the technical indicators (RSI/MACD/EMA) ~${wTechnicals}%, and the ETF-flow / other supplementary context ~${wEtf}% (for BNB, which has no spot ETF, redistribute that ${wEtf}% across options & technicals). Apply this weighting silently when forming your view — do NOT mention these percentages, the word "weight", or any numeric weighting in your reasoning. If a current ${asset} price from CoinMarketCap is provided, reference it explicitly in your reasoning:\n${extraContext}\n` : ""}
YOUR TASK: Provide a BINARY prediction for ${config.label} timeframe.

You must:
1. Choose a threshold price (a round number near current price that you're confident about)
2. Predict whether ${asset} will be ABOVE or BELOW that threshold in ${config.label}
3. Express your conviction as a calibrated confidence (0-1)

Respond in this exact JSON format:
{
  "threshold": <round number price level>,
  "conclusion": "ABOVE" | "BELOW",
  "targetPrice": <your expected price>,
  "priceChange": <percentage as number>,
  "direction": "up" | "down" | "sideways",
  "confidence": <0-1>,
  "rangeLow": <number>,
  "rangeHigh": <number>,
  "reasoning": "<brief explanation of why ABOVE/BELOW threshold — describe the signals in plain terms; do NOT mention weighting percentages, the word 'weight', or how much each signal category counts>"
}`;

  let headers: Record<string, string>;
  try {
    headers = {
      ...getOpenRouterHeaders(),
      "X-Title": "Astraeus Agent",
    };
  } catch (e) {
    throw new Error(
      `Failed to get API headers: ${e instanceof Error ? e.message : "Unknown error"}`,
    );
  }

  console.log(
    `[PricePredictor] Calling OpenRouter with model: ${MODELS.reasoning}`,
  );

  const callOnce = (signal: AbortSignal): Promise<Response> =>
    fetch(OPENROUTER_CONFIG.chatEndpoint, {
      method: "POST",
      headers,
      signal,
      body: JSON.stringify({
        model: MODELS.reasoning,
        messages: [
          {
            role: "system",
            content:
              "You are a professional options market analyst. Provide precise, calibrated price forecasts based on options market data. Always respond with valid JSON.",
          },
          { role: "user", content: prompt },
        ],
        temperature: 0.3,
        max_tokens: 1200,
      }),
    });

  // HARD per-attempt timeout: a socket that opens but never responds would otherwise
  // block `await callOnce()` FOREVER (fetch only rejects on a thrown error / closed
  // socket, not a silent stall). That freezes the whole forecast → trade cycle, and
  // because the autonomous loop arms its next timer only AFTER a cycle returns — and
  // the Track-1 heartbeat defers while a cycle is in flight — one stalled request
  // silently kills BOTH the loop and the daily-trade guarantee. Abort → treated as a
  // transient below → retried, then fails fast so runCycle can reschedule.
  const timeoutMs = num("FORECAST_LLM_TIMEOUT_MS", 60_000);
  // Retry on TRANSIENT failures only: network blips (fetch throws — "Unable to
  // connect", socket reset), a timeout abort, and 408/429/5xx. Auth/400/other 4xx
  // are real — fail fast.
  const maxAttempts = Math.max(1, num("FORECAST_LLM_RETRIES", 3));
  const retryMs = num("FORECAST_LLM_RETRY_MS", 1500);
  let response: Response | undefined;
  let lastErr = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let r: Response;
    try {
      r = await callOnce(ac.signal);
    } catch (e) {
      const aborted = e instanceof Error && e.name === "AbortError";
      lastErr = aborted
        ? `request timed out after ${timeoutMs}ms`
        : e instanceof Error
          ? e.message
          : String(e);
      if (attempt === maxAttempts)
        throw new Error(
          `OpenRouter call failed after ${maxAttempts} attempts: ${lastErr}`,
        );
      console.warn(
        `[PricePredictor] ${aborted ? "timeout" : "network error"} "${lastErr}", retrying (${attempt}/${maxAttempts})…`,
      );
      await sleep(retryMs * attempt);
      continue;
    } finally {
      clearTimeout(timer);
    }
    if (r.ok) {
      response = r;
      break;
    }
    const transient = r.status === 408 || r.status === 429 || r.status >= 500;
    const errorBody = await r.text().catch(() => "Unknown error");
    lastErr = `OpenRouter API error: ${r.status} - ${errorBody}`;
    if (!transient || attempt === maxAttempts) {
      console.error(`[PricePredictor] ${lastErr}`);
      throw new Error(lastErr);
    }
    console.warn(
      `[PricePredictor] transient ${r.status}, retrying (${attempt}/${maxAttempts})…`,
    );
    await sleep(retryMs * attempt);
  }
  if (!response) throw new Error(`OpenRouter call failed: ${lastErr}`);

  const result = await response.json();
  const content = result.choices?.[0]?.message?.content;

  if (!content) {
    console.error(`[PricePredictor] Empty response from LLM:`, result);
    throw new Error(
      `No response from LLM. Model: ${MODELS.reasoning}. Response: ${JSON.stringify(result)}`,
    );
  }

  console.log(
    `[PricePredictor] LLM response received (${content.length} chars)`,
  );

  // Parse JSON from response. Tolerates markdown ```json fences and responses
  // truncated mid-`reasoning` by max_tokens (all numeric fields precede it, so a
  // repaired object is still a usable forecast). See parseLooseJson.
  const parsedResult = parseLooseJson(content);
  if (!parsedResult) {
    console.error(
      `[PricePredictor] Could not parse JSON from response (${content.length} chars): ${content.substring(0, 200)}`,
    );
    throw new Error("Could not parse JSON from LLM response");
  }
  if (parsedResult.repaired) {
    console.warn(
      `[PricePredictor] LLM response was truncated (${content.length} chars); salvaged forecast via JSON repair`,
    );
  }
  const parsed = parsedResult.value;

  // The LLM occasionally deviates from the contract (missing fields, uppercase
  // direction, numbers as strings). Normalize defensively so a malformed field can
  // never (a) silently neutralize a real signal — e.g. "UP" failing a `=== "up"`
  // check and blocking a trade — nor (b) leave an undefined number that throws in
  // downstream `.toLocaleString()` / `.toFixed()` formatting.
  const spot = data.spotPrice;
  const asNum = (v: unknown): number => {
    const n =
      typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
    return Number.isFinite(n) ? n : NaN;
  };

  let priceChange = asNum(parsed.priceChange);
  let targetPrice = asNum(parsed.targetPrice);
  if (!Number.isFinite(targetPrice) && Number.isFinite(priceChange))
    targetPrice = spot * (1 + priceChange / 100);
  if (!Number.isFinite(priceChange) && Number.isFinite(targetPrice))
    priceChange = ((targetPrice - spot) / spot) * 100;
  if (!Number.isFinite(targetPrice)) targetPrice = spot;
  if (!Number.isFinite(priceChange)) priceChange = 0;

  let direction = String(parsed.direction ?? "").toLowerCase();
  if (direction !== "up" && direction !== "down" && direction !== "sideways") {
    direction =
      priceChange > 0.3 ? "up" : priceChange < -0.3 ? "down" : "sideways";
  }

  const confRaw = asNum(parsed.confidence);
  let conf = Number.isFinite(confRaw) ? confRaw : 0.5;
  if (conf > 1) conf = conf / 100; // tolerate a 0–100 scale if the LLM ignores "0-1"
  const confidence = Math.max(0, Math.min(1, conf));

  let rangeLow = asNum(parsed.rangeLow);
  let rangeHigh = asNum(parsed.rangeHigh);
  if (!Number.isFinite(rangeLow)) rangeLow = Math.min(spot, targetPrice) * 0.98;
  if (!Number.isFinite(rangeHigh))
    rangeHigh = Math.max(spot, targetPrice) * 1.02;
  if (rangeLow > rangeHigh) [rangeLow, rangeHigh] = [rangeHigh, rangeLow];

  // Round-number threshold near spot if absent/invalid.
  const thrRaw = asNum(parsed.threshold);
  const threshold =
    Number.isFinite(thrRaw) && thrRaw > 0
      ? thrRaw
      : Math.round(spot / 100) * 100;
  const conclusionRaw = String(parsed.conclusion ?? "").toUpperCase();
  const conclusion: "ABOVE" | "BELOW" =
    conclusionRaw === "ABOVE" || conclusionRaw === "BELOW"
      ? conclusionRaw
      : direction === "down"
        ? "BELOW"
        : "ABOVE";

  const prediction: PricePrediction = {
    targetPrice,
    priceChange,
    direction: direction as PricePrediction["direction"],
    confidence,
    range: { low: rangeLow, high: rangeHigh },
    threshold,
    conclusion,
  };

  return {
    prediction,
    reasoning:
      typeof parsed.reasoning === "string"
        ? parsed.reasoning
        : "(no reasoning)",
  };
}

// ========== MAIN FORECAST FUNCTION ==========

export async function generateForecast(
  asset: Asset,
  timeframe: ForecastTimeframe,
  extraContext?: string,
): Promise<PriceForecast> {
  console.log(`Generating ${timeframe} forecast for ${asset}...`);

  // 1. Fetch options data
  const data = await fetchOptionsData(asset);

  if (data.spotPrice === 0) {
    throw new Error(`Could not fetch spot price for ${asset}`);
  }

  // 2. Extract signals
  const signals = extractSignals(data);

  // 3. Aggregate sentiment
  const sentiment = aggregateSignals(signals);

  // 4. Generate LLM forecast (extraContext = optional CMC options-positioning analysis)
  const { prediction, reasoning } = await generateLLMForecast(
    asset,
    timeframe,
    data,
    signals,
    sentiment,
    extraContext,
  );

  // 5. Calculate risk metrics
  const config = TIMEFRAME_CONFIG[timeframe];
  const expectedVolatility =
    (data.iv.current / 100) *
    Math.sqrt(config.hours / 8760) *
    config.volatilityMultiplier;

  let volatilityExpectation: "high" | "medium" | "low" = "medium";
  if (data.iv.percentile > 70) {
    volatilityExpectation = "high";
  } else if (data.iv.percentile < 30) {
    volatilityExpectation = "low";
  }

  const forecast: PriceForecast = {
    asset,
    timeframe,
    timestamp: Date.now(),
    currentPrice: data.spotPrice,
    prediction,
    signals,
    sentiment: {
      overall: sentiment.overall,
      score: sentiment.score,
      confidence: sentiment.confidence,
    },
    risk: {
      volatilityExpectation,
      maxDrawdown: expectedVolatility * 100 * 2, // 2x expected move
      riskRewardRatio:
        Math.abs(prediction.priceChange) / (expectedVolatility * 100) || 1,
    },
    reasoning,
    sourcesUsed: data.sources,
  };

  console.log(
    `${asset} ${timeframe} forecast: ${prediction.direction} ${prediction.priceChange.toFixed(1)}% ` +
      `to $${prediction.targetPrice.toLocaleString()} (confidence: ${(prediction.confidence * 100).toFixed(0)}%)`,
  );

  return forecast;
}

// Generate forecasts for all supported assets (BTC, ETH, BNB)
export async function generateAllForecasts(
  timeframe: ForecastTimeframe,
): Promise<Record<Asset, PriceForecast>> {
  const [btc, eth, bnb] = await Promise.all([
    generateForecast("BTC", timeframe),
    generateForecast("ETH", timeframe),
    generateForecast("BNB", timeframe),
  ]);

  return { BTC: btc, ETH: eth, BNB: bnb };
}

export default {
  generateForecast,
  generateAllForecasts,
};
