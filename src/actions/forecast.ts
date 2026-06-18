import {
  type Action,
  type ActionResult,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
  logger,
} from '@elizaos/core';
import { generateForecast, type Asset, type ForecastTimeframe } from '../skills/options-forecast';
import { fetchCmcOptionsContext } from '../skills/options-forecast/cmc-context';

const ASSET_PATTERNS: Array<[RegExp, Asset]> = [
  [/\b(btc|bitcoin|xbt)\b/i, 'BTC'],
  [/\b(eth|ether|ethereum)\b/i, 'ETH'],
  [/\b(bnb|binance\s*coin|binancecoin)\b/i, 'BNB'],
];

export function parseAsset(text: string): Asset | undefined {
  for (const [re, a] of ASSET_PATTERNS) if (re.test(text)) return a;
  return undefined;
}

export function parseTimeframe(text: string): ForecastTimeframe {
  const t = text.toLowerCase();
  if (/\b(4\s*-?\s*h(our)?s?|four\s*hour|4hr)\b/.test(t)) return 'fourHourly';
  if (/\b(1\s*-?\s*h(our)?|hourly|1hr|60\s*min)\b/.test(t)) return 'hourly';
  if (/\b(week(ly)?|7\s*-?\s*d(ay)?s?|1w)\b/.test(t)) return 'weekly';
  if (/\b(day|daily|24\s*-?\s*h(our)?s?|1d)\b/.test(t)) return 'daily';
  return 'daily';
}

const TF_LABEL: Record<ForecastTimeframe, string> = {
  hourly: '1H',
  fourHourly: '4H',
  daily: '1D',
  weekly: '1W',
};

/**
 * OPTIONS_FORECAST — exposes the options-forecast skill to chat.
 * Parses the asset (BTC/ETH/BNB) and timeframe from the user's message, runs the
 * skill, and returns a formatted directional forecast.
 */
export const forecastAction: Action = {
  name: 'OPTIONS_FORECAST',
  similes: ['FORECAST', 'PREDICT', 'PRICE_FORECAST', 'PRICE_PREDICTION', 'MARKET_OUTLOOK'],
  description:
    'Generate a directional price forecast for BTC, ETH, or BNB on a timeframe (hourly, 4-hourly, daily, weekly) from options + futures market data. Use whenever the user asks to forecast/predict/give an outlook or view on one of those assets.',

  validate: async (_runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    const text = (message.content?.text ?? '').toLowerCase();
    const wantsForecast = /(forecast|predict|prediction|outlook|strateg|view|target|direction|price|bull|bear)/.test(text);
    // Defer to FORECAST_AND_TRADE when the user also wants to trade.
    return wantsForecast && parseAsset(text) !== undefined && !/\btrade\b/i.test(text);
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined,
    _options: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const text = message.content?.text ?? '';
    const asset = parseAsset(text) ?? 'BTC';
    const timeframe = parseTimeframe(text);
    const useCmc = /\bcmc\b/i.test(text); // opt-in: only enrich with CMC when explicitly asked

    try {
      logger.info({ asset, timeframe, useCmc }, 'OPTIONS_FORECAST: generating forecast');
      let extraContext: string | undefined;
      if (useCmc) {
        await callback?.({ text: `Pulling CMC options-positioning analysis for ${asset} (this can take ~1–2 min)…` });
        extraContext = await fetchCmcOptionsContext(runtime, asset);
      }
      const f = await generateForecast(asset, timeframe, extraContext);
      const p = f.prediction;
      const arrow = p.direction === 'up' ? '▲' : p.direction === 'down' ? '▼' : '�—';
      const topSignals = f.signals
        .slice(0, 5)
        .map((s) => `  • ${s.indicator}: ${s.value} (${s.interpretation})`)
        .join('\n');

      const responseText =
        `${asset} ${TF_LABEL[timeframe]} forecast — ${arrow} ${p.direction.toUpperCase()}\n` +
        `• Target: $${p.targetPrice.toLocaleString()} (${p.priceChange >= 0 ? '+' : ''}${p.priceChange.toFixed(1)}%)\n` +
        `• Range: $${p.range.low.toLocaleString()} – $${p.range.high.toLocaleString()}\n` +
        `• Confidence: ${(p.confidence * 100).toFixed(0)}%\n` +
        `• Sentiment: ${f.sentiment.overall} (score ${f.sentiment.score})\n` +
        (topSignals ? `• Key signals:\n${topSignals}\n` : '') +
        (useCmc && extraContext ? '• Enriched with CMC options-positioning analysis\n' : '') +
        `• Reasoning: ${f.reasoning}`;

      await callback?.({ text: responseText, actions: ['OPTIONS_FORECAST'] });

      return {
        text: `Forecast generated for ${asset} ${timeframe}`,
        success: true,
        values: { asset, timeframe, direction: p.direction, confidence: p.confidence },
        data: { actionName: 'OPTIONS_FORECAST', forecast: f },
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error({ error: msg }, 'OPTIONS_FORECAST failed');
      await callback?.({ text: `Could not generate ${asset} ${TF_LABEL[timeframe]} forecast: ${msg}`, error: true });
      return {
        text: 'Forecast failed',
        success: false,
        error: error instanceof Error ? error : new Error(msg),
      };
    }
  },

  examples: [
    [
      { name: '{{name1}}', content: { text: 'forecast ETH on the 4 hour' } },
      {
        name: 'Astraeus',
        content: { text: 'ETH 4H forecast — ▲ UP\n• Target: ...', actions: ['OPTIONS_FORECAST'] },
      },
    ],
    [
      { name: '{{name1}}', content: { text: "what's your weekly view on BNB?" } },
      {
        name: 'Astraeus',
        content: { text: 'BNB 1W forecast — ▼ DOWN\n• Target: ...', actions: ['OPTIONS_FORECAST'] },
      },
    ],
  ],
};

export default forecastAction;
