/**
 * Eligible BEP-20 token universe for the BNB Hack Track 1 competition.
 *
 * Source: the hackathon's fixed list of BEP-20 tokens listed on CoinMarketCap
 * ("Trades outside the list do not count."). This is the agent's allowlist —
 * the trading loop must reject any token not in here (a Track 1 guardrail).
 *
 * IMPORTANT:
 * - This is the SYMBOL universe. Live execution needs each token's BSC contract
 *   address; resolve those via CoinMarketCap / TWAK at runtime, do not hardcode
 *   blindly (symbols collide across chains).
 * - Verify against the official list before the trading window opens — the
 *   organizers may amend it.
 */

/** The eligible symbols, in the order published by the organizers. */
export const ELIGIBLE_TOKENS: readonly string[] = [
  'ETH', 'USDT', 'USDC', 'XRP', 'TRX', 'DOGE', 'ZEC', 'ADA', 'LINK', 'BCH',
  'DAI', 'TON', 'USD1', 'USDe', 'M', 'LTC', 'AVAX', 'SHIB', 'XAUt', 'WLFI',
  'H', 'DOT', 'UNI', 'ASTER', 'DEXE', 'USDD', 'ETC', 'AAVE', 'ATOM', 'U',
  'STABLE', 'FIL', 'INJ', '币安人生', 'NIGHT', 'FET', 'TUSD', 'BONK', 'PENGU', 'CAKE',
  'SIREN', 'LUNC', 'ZRO', 'KITE', 'FDUSD', 'BEAT', 'PIEVERSE', 'BTT', 'NFT', 'EDGE',
  'FLOKI', 'LDO', 'B', 'FF', 'PENDLE', 'NEX', 'STG', 'AXS', 'TWT', 'HOME',
  'RAY', 'COMP', 'GWEI', 'XCN', 'GENIUS', 'XPL', 'BAT', 'SKYAI', 'APE', 'IP',
  'SFP', 'TAG', 'NXPC', 'AB', 'SAHARA', '1INCH', 'CHEEMS', 'BANANAS31', 'RIVER', 'MYX',
  'RAVE', 'SNX', 'FORM', 'LAB', 'HTX', 'USDf', 'CTM', 'BDX', 'SLX', 'UB',
  'DUCKY', 'FRAX', 'BILL', 'WFI', 'KOGE', 'ALE', 'FRXUSD', 'USDF', 'GOMINING', 'VCNT',
  'GUA', 'DUSD', 'SMILEK', '0G', 'BEAM', 'MY', 'SOON', 'REAL', 'Q', 'AIOZ',
  'ZIG', 'YFI', 'TAC', 'lisUSD', 'CYS', 'ZAMA', 'TRIA', 'HUMA', 'PLUME', 'ZIL',
  'XPR', 'ZETA', 'BabyDoge', 'NILA', 'ROSE', 'VELO', 'UAI', 'BRETT', 'OPEN', 'BSB',
  'TOSHI', 'BAS', 'ACH', 'AXL', 'LUR', 'ELF', 'KAVA', 'APR', 'IRYS', 'EURI',
  'XUSD', 'BARD', 'DUSK', 'SUSHI', 'PEAQ', 'COAI', 'BDCA', 'XAUM',
];

/** Symbols that are stablecoins — useful as the agent's cash/dry-powder leg. */
export const STABLE_SYMBOLS: readonly string[] = [
  'USDT', 'USDC', 'DAI', 'USD1', 'USDe', 'USDD', 'TUSD', 'FDUSD',
  'FRAX', 'FRXUSD', 'USDf', 'USDF', 'DUSD', 'lisUSD', 'XUSD', 'EURI',
];

const eligibleSet = new Set(ELIGIBLE_TOKENS.map((s) => s.toLowerCase()));
const stableSet = new Set(STABLE_SYMBOLS.map((s) => s.toLowerCase()));

/** Case-insensitive membership check against the eligible allowlist. */
export function isEligibleToken(symbol: string): boolean {
  return eligibleSet.has(symbol.trim().toLowerCase());
}

/** Is this symbol one of the recognized stablecoins (the agent's cash leg)? */
export function isStable(symbol: string): boolean {
  return stableSet.has(symbol.trim().toLowerCase());
}
