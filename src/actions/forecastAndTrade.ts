import {
  type Action,
  type ActionResult,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
  logger,
} from '@elizaos/core';
import { parseAsset, parseTimeframe } from './forecast';
import { TradingService } from '../agent/service';
import type { Asset, ForecastTimeframe } from '../skills/options-forecast';

const TF_LABEL: Record<ForecastTimeframe, string> = { hourly: '1H', fourHourly: '4H', daily: '1D', weekly: '1W' };
const TF_HOLD: Record<ForecastTimeframe, string> = {
  hourly: '1 hour',
  fourHourly: '4 hours',
  daily: '24 hours',
  weekly: '7 days',
};

/**
 * FORECAST_AND_TRADE — "forecast and trade" command.
 *
 * Forecasts the named asset (BTC/ETH/BNB, default ETH) for the requested timeframe
 * and, ONLY if the forecast is UP, buys a fixed USD size of it as spot vs USDT that
 * AUTO-CLOSES after the timeframe (hourly→1h … weekly→7d), restart-safe. Add "cmc" to
 * enrich the forecast with CoinMarketCap options analysis.
 */
export const forecastAndTradeAction: Action = {
  name: 'FORECAST_AND_TRADE',
  similes: ['FORECAST_TRADE', 'TRADE_FORECAST', 'FORECAST_AND_BUY', 'TRADE_ETH'],
  description:
    'Forecast BTC, ETH or BNB (default ETH) for a timeframe (hourly/4-hourly/daily/weekly) and, ONLY if the forecast is UP, buy a fixed size of it spot vs USDT that AUTO-CLOSES after the timeframe. Use when the user asks to "forecast and trade <asset>" (optionally with "cmc").',

  validate: async (_runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    const t = (message.content?.text ?? '').toLowerCase();
    return /forecast/.test(t) && /\b(trade|buy)\b/.test(t);
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined,
    _options: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const text = message.content?.text ?? '';
    const timeframe = parseTimeframe(text);
    const asset: Asset = parseAsset(text) ?? 'ETH';
    const useCmc = /\bcmc\b/i.test(text);

    const svc = runtime.getService(TradingService.serviceType) as unknown as TradingService | null;
    if (!svc) {
      await callback?.({ text: 'Trading service is not available (plugin not loaded?).', error: true });
      return { text: 'no service', success: false };
    }

    try {
      if (useCmc) {
        await callback?.({ text: `Forecasting ${asset} ${TF_LABEL[timeframe]} with CMC options analysis, then trading if UP…` });
      }
      const r = await svc.forecastAndTrade(timeframe, useCmc, asset);

      let out: string;
      if (r.traded) {
        out =
          `📈 ${asset} ${TF_LABEL[timeframe]} forecast: ▲ UP (${((r.confidence ?? 0) * 100).toFixed(0)}% confidence)\n` +
          `→ BOUGHT $${r.sizeUsd} of ${asset} @ $${(r.entryPrice ?? 0).toLocaleString()} (${r.txHash})\n` +
          `→ Auto-closes in ${TF_HOLD[timeframe]} (${new Date(r.closeAt ?? 0).toUTCString()})`;
      } else {
        out =
          `${asset} ${TF_LABEL[timeframe]} forecast: ${(r.direction ?? '?').toUpperCase()} — no trade.\n` +
          `Reason: ${r.reason}` +
          (r.forecastReasoning ? `\n${r.forecastReasoning}` : '');
      }

      await callback?.({ text: out, actions: ['FORECAST_AND_TRADE'] });
      return {
        text: r.traded ? 'traded' : 'no trade',
        success: r.ok,
        values: { traded: r.traded, asset, timeframe, direction: r.direction },
        data: { actionName: 'FORECAST_AND_TRADE', result: r },
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error({ error: msg }, 'FORECAST_AND_TRADE failed');
      await callback?.({ text: `Forecast-and-trade error: ${msg}`, error: true });
      return { text: 'error', success: false, error: error instanceof Error ? error : new Error(msg) };
    }
  },

  examples: [
    [
      { name: '{{name1}}', content: { text: 'forecast and trade ETH daily' } },
      { name: 'Astraeus', content: { text: '📈 ETH 1D forecast: ▲ UP → BOUGHT $5 of ETH …', actions: ['FORECAST_AND_TRADE'] } },
    ],
    [
      { name: '{{name1}}', content: { text: 'forecast and trade eth 4 hour cmc' } },
      { name: 'Astraeus', content: { text: 'ETH 4H forecast: DOWN — no trade.', actions: ['FORECAST_AND_TRADE'] } },
    ],
  ],
};

export default forecastAndTradeAction;
