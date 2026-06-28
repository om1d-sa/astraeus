import {
  type Action,
  type ActionResult,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
  logger,
} from "@elizaos/core";
import { CmcDataProvider } from "../data/cmc";
import {
  runSkillBundle,
  skillList,
  synthesizeSkillSentiment,
  showRawSkillBundle,
  DEFAULT_TRENDING_SKILLS,
} from "../skills/options-forecast/skill-bundle";

/**
 * Pull a ticker watchlist out of the user's message. Anchored on a colon
 * ("…search trending in this list: ETH, USDT, …") when present, otherwise any
 * comma-separated run. Tickers are uppercased and de-duped, so mixed-case
 * (BabyDoge, lisUSD), unicode (币安人生), digit-leading (1INCH, 0G) and repeats
 * (SLX twice) all collapse correctly. Returns an empty Set when no list is found.
 */
export function parseTrendingWatchlist(text: string): Set<string> {
  const colon = text.indexOf(":");
  const region =
    colon >= 0 ? text.slice(colon + 1) : text.includes(",") ? text : "";
  if (!region.trim()) return new Set();
  // Phrasing words that show up around a list but are never tickers. Kept to
  // ≥4-char query words only — short words (MY, ME, ON, IN, M, B, U, Q, H…) are
  // left in because several are real tickers in the user's list. Junk that slips
  // through is harmless anyway: the output is CMC's trending set filtered DOWN to
  // this watchlist, so a non-symbol word here can never appear in the result.
  const STOP = new Set([
    "TRENDING",
    "TREND",
    "LIST",
    "CRYPTO",
    "CRYPTOS",
    "TOKEN",
    "TOKENS",
    "WHATS",
    "WHAT",
    "THIS",
    "FROM",
    "MOVERS",
    "GAINERS",
    "COINS",
    "SEARCH",
    "SHOW",
  ]);
  const out = new Set<string>();
  for (const raw of region.split(/[\s,]+/)) {
    const sym = raw.trim().toUpperCase();
    if (!sym || sym.length > 15) continue;
    if (STOP.has(sym)) continue;
    out.add(sym);
  }
  return out;
}

/**
 * The default trending watchlist — the user's BSC list, 146 unique symbols (after SLX and
 * USDf/USDF collapse). Used when the filter is ON and the message carries no inline list, so
 * a plain "what's trending?" filters to this list automatically. Override the whole list with
 * TRACK1_TRENDING_WATCHLIST (comma-separated) in .env.
 *
 * Notable edits vs the raw competition list:
 *   - GRAM added alongside TON — CoinMarketCap renamed Toncoin to "Gram" (symbol GRAM), so the
 *     trending feed now reports it as GRAM; keeping both lets the filter match either.
 *   - H and IP dropped — neither has a real BSC deployment on CMC (so no contract to route).
 */
export const DEFAULT_TRENDING_WATCHLIST_RAW =
  "ETH, USDT, USDC, XRP, TRX, DOGE, ZEC, ADA, LINK, BCH, DAI, TON, GRAM, USD1, USDe, M, LTC, " +
  "AVAX, SHIB, XAUt, WLFI, DOT, UNI, ASTER, DEXE, USDD, ETC, AAVE, ATOM, U, STABLE, FIL, " +
  "INJ, 币安人生, NIGHT, FET, TUSD, BONK, PENGU, CAKE, SIREN, LUNC, ZRO, KITE, FDUSD, BEAT, " +
  "PIEVERSE, BTT, NFT, EDGE, FLOKI, LDO, B, FF, PENDLE, NEX, STG, AXS, TWT, HOME, RAY, COMP, " +
  "GWEI, XCN, GENIUS, XPL, BAT, SKYAI, APE, SFP, TAG, NXPC, AB, SAHARA, 1INCH, CHEEMS, " +
  "BANANAS31, RIVER, MYX, RAVE, SNX, FORM, LAB, HTX, USDf, CTM, BDX, SLX, UB, DUCKY, FRAX, " +
  "BILL, WFI, KOGE, ALE, FRXUSD, USDF, GOMINING, VCNT, GUA, DUSD, SMILEK, 0G, BEAM, MY, SLX, " +
  "SOON, REAL, Q, AIOZ, ZIG, YFI, TAC, lisUSD, CYS, ZAMA, TRIA, HUMA, PLUME, ZIL, XPR, ZETA, " +
  "BabyDoge, NILA, ROSE, VELO, UAI, BRETT, OPEN, BSB, TOSHI, BAS, ACH, AXL, LUR, ELF, KAVA, " +
  "APR, IRYS, EURI, XUSD, BARD, DUSK, SUSHI, PEAQ, COAI, BDCA, XAUM";

/** TRACK1_TRENDING_WATCHLIST_FILTER — opt-in (default off). */
export function watchlistFilterEnabled(): boolean {
  return (
    (process.env.TRACK1_TRENDING_WATCHLIST_FILTER ?? "")
      .trim()
      .toLowerCase() === "true"
  );
}

/**
 * The effective watchlist used by the filter, in precedence order:
 *   1. an inline list in the message ("…in this list: ETH, MYX") — wins when present
 *   2. TRACK1_TRENDING_WATCHLIST from .env (comma-separated), if set
 *   3. the baked-in DEFAULT_TRENDING_WATCHLIST_RAW
 * So with the toggle on, a plain "what's trending?" filters to the default 146 tokens
 * without the user having to paste the list into every command.
 */
export function resolveTrendingWatchlist(text: string): Set<string> {
  const inline = parseTrendingWatchlist(text);
  if (inline.size > 0) return inline;
  const envList = (process.env.TRACK1_TRENDING_WATCHLIST ?? "").trim();
  return parseTrendingWatchlist(envList || DEFAULT_TRENDING_WATCHLIST_RAW);
}

/** TRACK1_TRENDING_SEARCH_CAP — how wide a trending window to pull before filtering. */
export function trendingSearchCap(): number {
  const n = Number(process.env.TRACK1_TRENDING_SEARCH_CAP);
  return Math.min(Math.max(Number.isFinite(n) ? Math.trunc(n) : 30, 1), 100);
}

/** TRENDING_DEFAULT_LIMIT — how many trending tokens to report when the message names no count. Default 10, clamped to 1–100. */
export function trendingDefaultLimit(): number {
  const n = Number(process.env.TRENDING_DEFAULT_LIMIT);
  return Math.min(Math.max(Number.isFinite(n) ? Math.trunc(n) : 10, 1), 100);
}

/**
 * TRENDING — top trending tokens by CoinMarketCap market activity.
 * Read-only CMC data; useful for spotting what's hot before considering a trade.
 */
export const trendingAction: Action = {
  name: "TRENDING",
  similes: ["TRENDING_TOKENS", "WHATS_HOT", "HOT_COINS", "MOVERS", "GAINERS"],
  description:
    'List the top trending tokens by CoinMarketCap market activity. Use for "trending", "what\'s hot", "top movers".',

  validate: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
  ): Promise<boolean> => {
    const t = (message.content?.text ?? "").toLowerCase();
    return /\b(trending|what'?s hot|hot coins?|top movers?|biggest movers?|gainers?)\b/.test(
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
    try {
      const text0 = message.content?.text ?? "";
      // Explicit count in the message wins (clamped 1–20); otherwise fall back to
      // the env-configurable default (TRENDING_DEFAULT_LIMIT, default 10).
      const limitMatch = text0.match(/\b(\d{1,2})\b/);
      const limit = limitMatch
        ? Math.min(Math.max(Number(limitMatch[1]), 1), 20)
        : trendingDefaultLimit();

      // TRACK1_TRENDING_WATCHLIST_FILTER: when on, pull a wider trending window and keep
      // ONLY the watchlist symbols. The watchlist is an inline list from the message if
      // present, else TRACK1_TRENDING_WATCHLIST, else the baked-in default 146-token list
      // — so the filter works without re-pasting the list each time. The match is
      // deterministic (code, not the LLM) so off-list tokens can never appear.
      const watchlist = resolveTrendingWatchlist(text0);
      const useFilter = watchlistFilterEnabled() && watchlist.size > 0;

      const cmc = new CmcDataProvider();
      const fetched = await cmc.getTrending(
        useFilter ? trendingSearchCap() : limit,
      );
      const items = useFilter
        ? fetched.filter((t) => watchlist.has((t.symbol ?? "").toUpperCase()))
        : fetched;
      if (items.length === 0) {
        await callback?.({
          text:
            useFilter && fetched.length > 0
              ? "None of the tokens in your list are currently trending on CoinMarketCap."
              : "No trending data returned by CoinMarketCap.",
          actions: ["TRENDING"],
        });
        return {
          text: "none",
          success: true,
          values: { count: 0, filtered: useFilter },
        };
      }
      const lines = items.map((t, i) => {
        const chg =
          t.change24hPct !== undefined
            ? ` (${t.change24hPct >= 0 ? "+" : ""}${t.change24hPct.toFixed(1)}% 24h)`
            : "";
        const px =
          t.priceUsd !== undefined ? ` $${t.priceUsd.toLocaleString()}` : "";
        return `  ${i + 1}. ${t.symbol} — ${t.name}${px}${chg}`;
      });
      let text = `🔥 Trending on CoinMarketCap${useFilter ? " (from your list)" : ""}:\n${lines.join("\n")}`;
      // Optional CMC skill bundle (off unless CMC_SKILLS_ENABLED=true) → the LLM distills
      // it into one takeaway instead of a raw dump. Falls back to raw if synthesis fails.
      const skillCtx = await runSkillBundle(
        runtime,
        skillList("TRENDING_SKILLS", DEFAULT_TRENDING_SKILLS),
        {},
        // Per-symbol perp/structure skills fan across the majors for a market-wide read.
        { symbols: ["BTC", "ETH", "BNB"] },
      );
      if (skillCtx) {
        const synth = await synthesizeSkillSentiment(
          runtime,
          skillCtx,
          "trending crypto tokens",
        );
        if (synth)
          text += `\n\n📊 CMC skill read (${synth.sentiment >= 0 ? "+" : ""}${synth.sentiment.toFixed(2)}): ${synth.summary}`;
        else if (showRawSkillBundle()) text += `\n\n${skillCtx}`;
      }
      await callback?.({ text, actions: ["TRENDING"] });
      return {
        text: `trending: ${items.length}`,
        success: true,
        values: { count: items.length, filtered: useFilter },
        data: { actionName: "TRENDING", items, filtered: useFilter },
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error({ error: msg }, "TRENDING failed");
      await callback?.({
        text: `Could not fetch trending tokens: ${msg}`,
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
      { name: "{{name1}}", content: { text: "what's trending?" } },
      {
        name: "Astraeus",
        content: {
          text: "🔥 Trending on CoinMarketCap:\n  1. … ",
          actions: ["TRENDING"],
        },
      },
    ],
  ],
};

export default trendingAction;
