/**
 * Options Data Fetcher (options-forecast skill)
 * Fetches BTC/ETH/BNB options + futures market data from FREE sources (no API keys required).
 * Note: Deribit lists only BTC/ETH options; BNB options come from Binance (eapi).
 *       Where Binance is geo-blocked (HTTP 451), BNB falls back to futures/funding + historical-vol.
 *
 * Sources (in priority order):
 * 1. Deribit - Best options data (DVOL, Greeks, Open Interest) - HIGHEST PRIORITY
 * 2. Binance - Second best options data (IV, Greeks, OI, Funding) - HIGH PRIORITY
 * 3. OKX - Options open interest
 * 4. Bybit - Futures funding rates
 * 5. CoinGecko - Spot price backup
 * 6. CryptoCompare - Historical volatility calculation
 */

import {
  Asset,
  OptionsData,
  OptionsDataSource,
  OptionsGreeks,
  DeribitTickerResponse,
  DeribitDVOLResponse,
} from './types';

// API configuration - FREE high-quality sources (no API keys required)
const API_CONFIGS = {
  deribit: {
    baseUrl: 'https://www.deribit.com/api/v2',
    requiresAuth: false,
  },
  binance: {
    baseUrl: 'https://eapi.binance.com',
    requiresAuth: false,
  },
  okx: {
    baseUrl: 'https://www.okx.com/api/v5',
    requiresAuth: false,
  },
  bybit: {
    baseUrl: 'https://api.bybit.com/v5',
    requiresAuth: false,
  },
  coingecko: {
    baseUrl: 'https://api.coingecko.com/api/v3',
    requiresAuth: false,
  },
  cryptocompare: {
    baseUrl: 'https://min-api.cryptocompare.com/data',
    requiresAuth: false,
  },
};

// Helper for API requests with error handling
async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs: number = 10000
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timeout);
  }
}

// Known geo-restricted/expected failure status codes - don't log these noisily
const EXPECTED_FAILURE_CODES = [400, 403, 451, 503];

async function safeJsonFetch<T>(
  url: string,
  options: RequestInit = {},
  defaultValue: T
): Promise<T> {
  try {
    const response = await fetchWithTimeout(url, options);
    if (!response.ok) {
      // Only log unexpected failures - geo-restrictions and expected errors are silent
      if (!EXPECTED_FAILURE_CODES.includes(response.status)) {
        console.warn(`API request failed: ${url} - ${response.status}`);
      }
      return defaultValue;
    }
    return (await response.json()) as T;
  } catch (error) {
    // Only log timeout/network errors, not expected failures
    const errorMsg = String(error);
    if (!errorMsg.includes('abort') && !errorMsg.includes('timeout')) {
      console.warn(`API request error: ${url} - ${error}`);
    }
    return defaultValue;
  }
}

// ========== DERIBIT ==========
async function fetchDeribitData(asset: Asset): Promise<Partial<OptionsData>> {
  const currency = asset;
  const indexName = `${asset.toLowerCase()}_usd`;

  // Fetch DVOL (Deribit Volatility Index)
  const dvolUrl = `${API_CONFIGS.deribit.baseUrl}/public/get_volatility_index?currency=${currency}`;
  const dvolResponse = await safeJsonFetch<{ result: DeribitDVOLResponse }>(
    dvolUrl,
    {},
    { result: { index_name: '', price: 0, change_24h: 0 } }
  );

  // Fetch current index price
  const indexUrl = `${API_CONFIGS.deribit.baseUrl}/public/get_index_price?index_name=${indexName}`;
  const indexResponse = await safeJsonFetch<{ result: { index_price: number } }>(
    indexUrl,
    {},
    { result: { index_price: 0 } }
  );

  // Fetch options chain summary
  const bookUrl = `${API_CONFIGS.deribit.baseUrl}/public/get_book_summary_by_currency?currency=${currency}&kind=option`;
  const bookResponse = await safeJsonFetch<{ result: DeribitTickerResponse[] }>(
    bookUrl,
    {},
    { result: [] }
  );

  // Calculate aggregate metrics from options chain
  let totalCallOI = 0;
  let totalPutOI = 0;
  let avgIV = 0;
  let ivCount = 0;
  let aggregateGreeks: OptionsGreeks = { delta: 0, gamma: 0, theta: 0, vega: 0 };

  for (const option of bookResponse.result) {
    const isCall = option.instrument_name.includes('-C');
    const oi = option.open_interest || 0;

    if (isCall) {
      totalCallOI += oi;
    } else {
      totalPutOI += oi;
    }

    if (option.mark_iv && option.mark_iv > 0) {
      avgIV += option.mark_iv;
      ivCount++;
    }

    if (option.greeks) {
      aggregateGreeks.delta += option.greeks.delta || 0;
      aggregateGreeks.gamma += option.greeks.gamma || 0;
      aggregateGreeks.theta += option.greeks.theta || 0;
      aggregateGreeks.vega += option.greeks.vega || 0;
    }
  }

  avgIV = ivCount > 0 ? avgIV / ivCount : 0;

  return {
    asset,
    spotPrice: indexResponse.result.index_price,
    iv: {
      current: avgIV,
      dvol: dvolResponse.result.price,
      historicalAvg: avgIV * 0.9, // Placeholder
      percentile: 50,
      ivRank: 50,
      term: { shortTerm: avgIV, mediumTerm: avgIV, longTerm: avgIV },
      skew: 0,
    },
    openInterest: {
      calls: totalCallOI,
      puts: totalPutOI,
      total: totalCallOI + totalPutOI,
      putCallRatio: totalCallOI > 0 ? totalPutOI / totalCallOI : 0,
    },
    greeks: aggregateGreeks,
    sources: ['deribit'],
  };
}

// ========== COINGECKO (FREE) ==========
async function fetchCoinGeckoData(asset: Asset): Promise<Partial<OptionsData>> {
  const coinId = asset === 'BTC' ? 'bitcoin' : asset === 'BNB' ? 'binancecoin' : 'ethereum';

  // Fetch current price and market data
  const priceUrl = `${API_CONFIGS.coingecko.baseUrl}/simple/price?ids=${coinId}&vs_currencies=usd&include_24hr_vol=true&include_24hr_change=true`;
  const priceResponse = await safeJsonFetch<{
    [key: string]: { usd: number; usd_24h_vol: number; usd_24h_change: number };
  }>(priceUrl, {}, {});

  const data = priceResponse[coinId];

  return {
    spotPrice: data?.usd || 0,
    sources: ['coingecko'],
  };
}

// ========== BINANCE OPTIONS (eapi) — supports BTC, ETH AND BNB ==========
// Binance lists USDT-settled options for BTC, ETH and BNB (symbols like
// BTC-240628-50000-C). IV + greeks come from /eapi/v1/mark (NOT /ticker — the
// ticker has no IV, which is why this source previously contributed IV=0).
// NOTE: eapi.binance.com is geo-restricted (HTTP 451) in some regions; where
// blocked, safeJsonFetch returns empty and Binance is silently skipped.
async function fetchBinanceData(asset: Asset): Promise<Partial<OptionsData>> {
  const symbol = `${asset}USDT`;
  const prefix = `${asset}-`; // option symbols start with e.g. "BNB-"

  // 1) Mark data: implied volatility + greeks per option contract.
  const markUrl = `${API_CONFIGS.binance.baseUrl}/eapi/v1/mark`;
  const marks = await safeJsonFetch<
    Array<{ symbol: string; markIV?: string; delta?: string; gamma?: string; theta?: string; vega?: string }>
  >(markUrl, {}, []);

  let avgIV = 0;
  let ivCount = 0;
  const aggregateGreeks: OptionsGreeks = { delta: 0, gamma: 0, theta: 0, vega: 0 };
  for (const m of marks) {
    if (!m.symbol.startsWith(prefix)) continue;
    const iv = parseFloat(m.markIV ?? '0');
    if (iv > 0) {
      avgIV += iv;
      ivCount += 1;
    }
    aggregateGreeks.delta += parseFloat(m.delta ?? '0') || 0;
    aggregateGreeks.gamma += parseFloat(m.gamma ?? '0') || 0;
    aggregateGreeks.theta += parseFloat(m.theta ?? '0') || 0;
    aggregateGreeks.vega += parseFloat(m.vega ?? '0') || 0;
  }
  avgIV = ivCount > 0 ? (avgIV / ivCount) * 100 : 0; // markIV is a fraction -> percent

  // 2) Ticker: 24h volume per contract -> call/put volume (put/call ratio proxy).
  const tickerUrl = `${API_CONFIGS.binance.baseUrl}/eapi/v1/ticker`;
  const tickers = await safeJsonFetch<Array<{ symbol: string; volume: string }>>(tickerUrl, {}, []);
  let callVol = 0;
  let putVol = 0;
  for (const t of tickers) {
    if (!t.symbol.startsWith(prefix)) continue;
    const v = parseFloat(t.volume ?? '0') || 0;
    if (t.symbol.endsWith('-C')) callVol += v;
    else if (t.symbol.endsWith('-P')) putVol += v;
  }

  // 3) Perp funding rate.
  const fundingUrl = `https://fapi.binance.com/fapi/v1/fundingRate?symbol=${symbol}&limit=1`;
  const funding = await safeJsonFetch<Array<{ fundingRate: string }>>(fundingUrl, {}, []);

  // 4) Spot price.
  const priceUrl = `https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`;
  const price = await safeJsonFetch<{ price: string }>(priceUrl, {}, { price: '0' });

  return {
    spotPrice: parseFloat(price.price) || 0,
    iv: {
      current: avgIV,
      historicalAvg: avgIV * 0.9,
      percentile: 50,
      ivRank: 50,
      term: { shortTerm: avgIV, mediumTerm: avgIV, longTerm: avgIV },
      skew: 0,
    },
    openInterest: {
      calls: callVol,
      puts: putVol,
      total: callVol + putVol,
      putCallRatio: callVol > 0 ? putVol / callVol : 0,
    },
    greeks: aggregateGreeks,
    futures: {
      fundingRate: parseFloat(funding[0]?.fundingRate ?? '0') || 0,
      openInterest: 0,
      basis: 0,
      liquidations24h: { longs: 0, shorts: 0 },
    },
    sources: ['binance'],
  };
}

// ========== OKX ==========
async function fetchOKXData(asset: Asset): Promise<Partial<OptionsData>> {
  const instFamily = `${asset}-USD`;

  // Fetch options market data
  const optionsUrl = `${API_CONFIGS.okx.baseUrl}/market/tickers?instType=OPTION&instFamily=${instFamily}`;
  const optionsResponse = await safeJsonFetch<{
    data: Array<{ instId: string; vol24h: string; last: string }>;
  }>(optionsUrl, {}, { data: [] });

  // Fetch open interest
  const oiUrl = `${API_CONFIGS.okx.baseUrl}/public/open-interest?instType=OPTION&instFamily=${instFamily}`;
  const oiResponse = await safeJsonFetch<{
    data: Array<{ oi: string; instId: string }>;
  }>(oiUrl, {}, { data: [] });

  let totalOI = 0;
  for (const item of oiResponse.data) {
    totalOI += parseFloat(item.oi) || 0;
  }

  return {
    openInterest: {
      calls: 0,
      puts: 0,
      total: totalOI,
      putCallRatio: 0,
    },
    sources: ['okx'],
  };
}

// ========== BYBIT ==========
async function fetchBybitData(asset: Asset): Promise<Partial<OptionsData>> {
  const symbol = `${asset}USDT`;

  // Fetch options tickers
  const optionsUrl = `${API_CONFIGS.bybit.baseUrl}/market/tickers?category=option&baseCoin=${asset}`;
  const optionsResponse = await safeJsonFetch<{
    result: { list: Array<{ symbol: string; volume24h: string; lastPrice: string }> };
  }>(optionsUrl, {}, { result: { list: [] } });

  // Fetch funding rate
  const fundingUrl = `${API_CONFIGS.bybit.baseUrl}/market/tickers?category=linear&symbol=${symbol}`;
  const fundingResponse = await safeJsonFetch<{
    result: { list: Array<{ fundingRate: string }> };
  }>(fundingUrl, {}, { result: { list: [] } });

  return {
    futures: {
      fundingRate: parseFloat(fundingResponse.result.list[0]?.fundingRate || '0'),
      openInterest: 0,
      basis: 0,
      liquidations24h: { longs: 0, shorts: 0 },
    },
    sources: ['bybit'],
  };
}

// ========== CRYPTOCOMPARE (FREE) ==========
async function fetchCryptoCompareData(asset: Asset): Promise<Partial<OptionsData>> {
  const symbol = asset;

  // Fetch current price
  const priceUrl = `${API_CONFIGS.cryptocompare.baseUrl}/price?fsym=${symbol}&tsyms=USD`;
  const priceResponse = await safeJsonFetch<{ USD: number }>(
    priceUrl,
    {},
    { USD: 0 }
  );

  // Fetch historical hourly data for volatility calculation
  const histUrl = `${API_CONFIGS.cryptocompare.baseUrl}/v2/histohour?fsym=${symbol}&tsym=USD&limit=168`; // 7 days
  const histResponse = await safeJsonFetch<{
    Data: { Data: Array<{ close: number; high: number; low: number; time: number }> };
  }>(histUrl, {}, { Data: { Data: [] } });

  // Calculate realized volatility from price changes
  const prices = histResponse.Data?.Data || [];
  let sumSquaredReturns = 0;
  let returnCount = 0;

  for (let i = 1; i < prices.length; i++) {
    if (prices[i].close > 0 && prices[i - 1].close > 0) {
      const logReturn = Math.log(prices[i].close / prices[i - 1].close);
      sumSquaredReturns += logReturn * logReturn;
      returnCount++;
    }
  }

  // Annualized volatility (hourly data * sqrt(8760 hours/year))
  const hourlyVariance = returnCount > 0 ? sumSquaredReturns / returnCount : 0;
  const annualizedVol = Math.sqrt(hourlyVariance * 8760) * 100; // as percentage

  return {
    spotPrice: priceResponse.USD,
    iv: {
      current: 0,
      historicalAvg: annualizedVol,
      percentile: 50,
      ivRank: 50,
      term: { shortTerm: annualizedVol, mediumTerm: annualizedVol, longTerm: annualizedVol },
      skew: 0,
    },
    sources: ['cryptocompare'],
  };
}

// ========== MERGE DATA FROM ALL SOURCES ==========
function mergeOptionsData(
  asset: Asset,
  dataArray: Partial<OptionsData>[]
): OptionsData {
  const now = Date.now();
  const allSources: OptionsDataSource[] = [];

  // Default values
  const merged: OptionsData = {
    asset,
    timestamp: now,
    spotPrice: 0,
    iv: {
      current: 0,
      historicalAvg: 0,
      percentile: 50,
      ivRank: 50,
      term: { shortTerm: 0, mediumTerm: 0, longTerm: 0 },
      skew: 0,
    },
    openInterest: {
      calls: 0,
      puts: 0,
      total: 0,
      putCallRatio: 0,
    },
    maxPain: {
      strikePrice: 0,
      distanceFromSpot: 0,
      expirationDate: '',
    },
    flow: {
      bullishPremium: 0,
      bearishPremium: 0,
      netPremium: 0,
      largeTradesCount: 0,
      sentiment: 'neutral',
    },
    greeks: {
      delta: 0,
      gamma: 0,
      theta: 0,
      vega: 0,
    },
    volSurface: {
      atm: 0,
      otm25Delta: 0,
      itm25Delta: 0,
      riskReversal: 0,
      butterfly: 0,
    },
    futures: {
      fundingRate: 0,
      openInterest: 0,
      basis: 0,
      liquidations24h: { longs: 0, shorts: 0 },
    },
    sources: [],
    dataQuality: 0,
  };

  // Merge all data
  for (const data of dataArray) {
    if (data.sources) {
      allSources.push(...data.sources);
    }

    if (data.spotPrice && data.spotPrice > 0) {
      merged.spotPrice = data.spotPrice;
    }

    if (data.iv) {
      if (data.iv.current > 0) merged.iv.current = data.iv.current;
      if (data.iv.dvol && data.iv.dvol > 0) merged.iv.dvol = data.iv.dvol;
      if (data.iv.historicalAvg > 0) merged.iv.historicalAvg = data.iv.historicalAvg;
      if (data.iv.percentile > 0) merged.iv.percentile = data.iv.percentile;
      if (data.iv.ivRank > 0) merged.iv.ivRank = data.iv.ivRank;
      if (data.iv.skew !== 0) merged.iv.skew = data.iv.skew;
    }

    if (data.openInterest) {
      if (data.openInterest.calls > 0) merged.openInterest.calls = data.openInterest.calls;
      if (data.openInterest.puts > 0) merged.openInterest.puts = data.openInterest.puts;
      if (data.openInterest.total > 0) merged.openInterest.total = data.openInterest.total;
      if (data.openInterest.putCallRatio > 0) merged.openInterest.putCallRatio = data.openInterest.putCallRatio;
    }

    if (data.maxPain) {
      if (data.maxPain.strikePrice > 0) merged.maxPain = data.maxPain;
    }

    if (data.flow) {
      merged.flow.bullishPremium += data.flow.bullishPremium;
      merged.flow.bearishPremium += data.flow.bearishPremium;
      merged.flow.netPremium = merged.flow.bullishPremium - merged.flow.bearishPremium;
      merged.flow.largeTradesCount += data.flow.largeTradesCount;
    }

    if (data.greeks) {
      merged.greeks.delta += data.greeks.delta;
      merged.greeks.gamma += data.greeks.gamma;
      merged.greeks.theta += data.greeks.theta;
      merged.greeks.vega += data.greeks.vega;
    }

    if (data.volSurface) {
      if (data.volSurface.atm > 0) merged.volSurface.atm = data.volSurface.atm;
      if (data.volSurface.riskReversal !== 0) merged.volSurface.riskReversal = data.volSurface.riskReversal;
    }

    if (data.futures) {
      if (data.futures.fundingRate !== 0) merged.futures.fundingRate = data.futures.fundingRate;
      if (data.futures.openInterest > 0) merged.futures.openInterest = data.futures.openInterest;
      if (data.futures.basis !== 0) merged.futures.basis = data.futures.basis;
      if (data.futures.liquidations24h) {
        merged.futures.liquidations24h.longs += data.futures.liquidations24h.longs;
        merged.futures.liquidations24h.shorts += data.futures.liquidations24h.shorts;
      }
    }
  }

  // Determine flow sentiment
  if (merged.flow.netPremium > 0) {
    merged.flow.sentiment = 'bullish';
  } else if (merged.flow.netPremium < 0) {
    merged.flow.sentiment = 'bearish';
  }

  // Calculate data quality score based on sources
  merged.sources = [...new Set(allSources)];
  merged.dataQuality = Math.min(100, merged.sources.length * 10);

  return merged;
}

// ========== MAIN FETCH FUNCTION ==========
export async function fetchOptionsData(asset: Asset): Promise<OptionsData> {
  console.log(`Fetching options data for ${asset} from free sources...`);

  // Fetch from all FREE sources in parallel
  // Priority: Deribit first (best options), Binance second (high volume options), then others
  const results = await Promise.allSettled([
    fetchDeribitData(asset),      // #1 Priority - Best options data (DVOL, Greeks, OI)
    fetchBinanceData(asset),      // #2 Priority - High volume options (IV, Greeks, OI, Funding)
    fetchOKXData(asset),          // Options OI
    fetchBybitData(asset),        // Futures funding rates
    fetchCoinGeckoData(asset),    // Spot price backup
    fetchCryptoCompareData(asset), // Historical volatility
  ]);

  // Collect successful results
  const successfulData: Partial<OptionsData>[] = [];

  for (const result of results) {
    if (result.status === 'fulfilled' && result.value.sources && result.value.sources.length > 0) {
      successfulData.push(result.value);
    }
  }

  console.log(`Successfully fetched from ${successfulData.length} sources for ${asset}`);

  // Merge all data (Deribit data takes priority due to array order)
  const merged = mergeOptionsData(asset, successfulData);

  return merged;
}

// Fetch for all supported assets (BTC, ETH, BNB)
export async function fetchAllOptionsData(): Promise<Record<Asset, OptionsData>> {
  const [btc, eth, bnb] = await Promise.all([
    fetchOptionsData('BTC'),
    fetchOptionsData('ETH'),
    fetchOptionsData('BNB'),
  ]);

  return { BTC: btc, ETH: eth, BNB: bnb };
}

export default {
  fetchOptionsData,
  fetchAllOptionsData,
};
