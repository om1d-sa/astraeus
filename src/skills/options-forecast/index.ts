/**
 * Options-Forecast Skill (Track 2 strategy skill).
 *
 * Turns options + futures market data into directional price forecasts for
 * BTC, ETH and BNB across four timeframes (hourly, 4-hourly, daily, weekly).
 *
 * Pipeline: fetch multi-source market data → extract signals (IV, DVOL,
 * put/call, max-pain, flow, funding, liquidations, skew) → aggregate sentiment
 * → LLM produces a calibrated directional call with an above/below threshold.
 *
 * Pure data sources (Deribit/Binance/OKX/Bybit/CoinGecko/CryptoCompare) — no
 * Sapience, no on-chain dependency. BNB degrades gracefully to futures/funding
 * + historical-vol signals since listed BNB options are thin.
 */
export type {
  Asset,
  ForecastTimeframe,
  OptionsData,
  OptionsSignal,
  PriceForecast,
  PricePrediction,
} from './types';

export { fetchOptionsData, fetchAllOptionsData } from './fetcher';
export { generateForecast, generateAllForecasts } from './predictor';

/** The four timeframes this skill forecasts. */
export const FORECAST_TIMEFRAMES = ['hourly', 'fourHourly', 'daily', 'weekly'] as const;

/** The assets this skill forecasts. */
export const FORECAST_ASSETS = ['BTC', 'ETH', 'BNB'] as const;
