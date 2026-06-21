/**
 * Options-market data types for the Astraeus options-forecast skill.
 * Powers directional price forecasts for BTC, ETH and BNB across timeframes.
 */

// Supported assets
export type Asset = 'BTC' | 'ETH' | 'BNB';

// Timeframes for forecasts
export type ForecastTimeframe = 'hourly' | 'fourHourly' | 'daily' | 'weekly';

// Data source identifiers - FREE high-quality sources
export type OptionsDataSource =
  | 'deribit'      // Best options data (highest volume)
  | 'binance'      // Futures + options
  | 'okx'          // Futures + options
  | 'bybit'        // Futures + options
  | 'coingecko';   // Spot prices + market data

// Greek values for options
export interface OptionsGreeks {
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  rho?: number;
}

// Open Interest data
export interface OpenInterestData {
  calls: number;
  puts: number;
  total: number;
  putCallRatio: number;
  change24h?: number;
}

// Implied Volatility data
export interface ImpliedVolatilityData {
  current: number;
  historicalAvg: number;
  percentile: number; // IV percentile (0-100)
  ivRank: number; // IV rank (0-100)
  term: {
    shortTerm: number; // < 7 days
    mediumTerm: number; // 7-30 days
    longTerm: number; // > 30 days
  };
  skew: number; // Put-Call IV skew
  dvol?: number; // Deribit DVOL index
}

// Max Pain data
export interface MaxPainData {
  strikePrice: number;
  distanceFromSpot: number; // percentage
  expirationDate: string;
}

// Options flow data (large trades)
export interface OptionsFlowData {
  bullishPremium: number;
  bearishPremium: number;
  netPremium: number; // positive = bullish, negative = bearish
  largeTradesCount: number;
  sentiment: 'bullish' | 'bearish' | 'neutral';
}

// Futures data for context
export interface FuturesData {
  fundingRate: number;
  openInterest: number;
  basis: number; // futures premium/discount to spot
  liquidations24h: {
    longs: number;
    shorts: number;
  };
}

// Volatility surface data
export interface VolatilitySurface {
  atm: number; // at-the-money IV
  otm25Delta: number; // 25 delta OTM IV
  itm25Delta: number; // 25 delta ITM IV
  riskReversal: number; // 25 delta risk reversal
  butterfly: number; // 25 delta butterfly
}

// Complete options data for an asset
export interface OptionsData {
  asset: Asset;
  timestamp: number;
  spotPrice: number;

  // Implied Volatility
  iv: ImpliedVolatilityData;

  // Open Interest
  openInterest: OpenInterestData;

  // Max Pain
  maxPain: MaxPainData;

  // Options Flow
  flow: OptionsFlowData;

  // Greeks (aggregate)
  greeks: OptionsGreeks;

  // Volatility Surface
  volSurface: VolatilitySurface;

  // Futures context
  futures: FuturesData;

  // Source metadata
  sources: OptionsDataSource[];
  dataQuality: number; // 0-100 score
}

// Individual signal from options analysis
export interface OptionsSignal {
  indicator: string;
  value: number | string;
  interpretation: 'bullish' | 'bearish' | 'neutral';
  weight: number; // 0-1, importance of this signal
  confidence: number; // 0-1
  source: OptionsDataSource;
}

// Price prediction for a specific timeframe
export interface PricePrediction {
  targetPrice: number;
  priceChange: number; // percentage
  direction: 'up' | 'down' | 'sideways';
  confidence: number; // 0-1
  range: {
    low: number;
    high: number;
  };
  // Optional binary view: is price expected ABOVE or BELOW a threshold?
  threshold: number; // reference price level
  conclusion: 'ABOVE' | 'BELOW'; // directional binary outcome
}

// Complete forecast output
export interface PriceForecast {
  asset: Asset;
  timeframe: ForecastTimeframe;
  timestamp: number;
  currentPrice: number;

  prediction: PricePrediction;

  // Supporting signals
  signals: OptionsSignal[];

  // Aggregate sentiment
  sentiment: {
    overall: 'bullish' | 'bearish' | 'neutral';
    score: number; // -100 to 100
    confidence: number; // 0-1
  };

  // Risk metrics
  risk: {
    volatilityExpectation: 'high' | 'medium' | 'low';
    maxDrawdown: number; // percentage
    riskRewardRatio: number;
  };

  // Natural language reasoning
  reasoning: string;

  // Data sources used
  sourcesUsed: OptionsDataSource[];
}

// Scheduled forecast configuration
export interface ForecastSchedule {
  hourly: {
    enabled: boolean;
    lastRun?: number;
    nextRun?: number;
  };
  fourHourly: {
    enabled: boolean;
    lastRun?: number;
    nextRun?: number;
  };
  daily: {
    enabled: boolean;
    lastRun?: number;
    nextRun?: number;
  };
  weekly: {
    enabled: boolean;
    lastRun?: number;
    nextRun?: number;
  };
}

// API response types for different sources

// Deribit API types
export interface DeribitTickerResponse {
  instrument_name: string;
  underlying_price: number;
  mark_iv: number;
  bid_iv: number;
  ask_iv: number;
  greeks: {
    delta: number;
    gamma: number;
    theta: number;
    vega: number;
    rho: number;
  };
  open_interest: number;
  volume: number;
}

export interface DeribitDVOLResponse {
  index_name: string;
  price: number;
  change_24h: number;
}

// CoinGlass API types
export interface CoinGlassOIResponse {
  symbol: string;
  openInterest: number;
  openInterestAmount: number;
  longRate: number;
  shortRate: number;
  longVolUsd: number;
  shortVolUsd: number;
}

export interface CoinGlassFundingResponse {
  symbol: string;
  fundingRate: number;
  nextFundingTime: number;
}

// Binance Options API types
export interface BinanceOptionsResponse {
  symbol: string;
  priceChange: string;
  priceChangePercent: string;
  lastPrice: string;
  volume: string;
  amount: string;
  bidPrice: string;
  askPrice: string;
  openPrice: string;
  highPrice: string;
  lowPrice: string;
  strikePrice: string;
  exercisePrice: string;
}

// Laevitas API types (options analytics)
export interface LaevitasMaxPainResponse {
  symbol: string;
  expiry: string;
  maxPain: number;
  callOI: number;
  putOI: number;
  spotPrice: number;
}

// Agent state for tracking
export interface AgentState {
  lastForecasts: {
    BTC: Record<ForecastTimeframe, PriceForecast | null>;
    ETH: Record<ForecastTimeframe, PriceForecast | null>;
    BNB: Record<ForecastTimeframe, PriceForecast | null>;
  };
  schedule: ForecastSchedule;
  tradesExecuted: number;
  forecastsGenerated: number;
  startedAt: number;
}
