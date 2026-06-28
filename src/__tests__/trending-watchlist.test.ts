import { afterEach, describe, expect, it, spyOn } from "bun:test";
import {
  DEFAULT_TRENDING_WATCHLIST_RAW,
  parseTrendingWatchlist,
  resolveTrendingWatchlist,
  trendingAction,
  trendingDefaultLimit,
  trendingSearchCap,
  watchlistFilterEnabled,
} from "../actions/trending";
import { CmcDataProvider } from "../data/cmc";
import {
  createMockMessage,
  createMockRuntime,
  createMockState,
} from "./utils/core-test-utils";

/**
 * Unit tests for the TRENDING watchlist parser — the deterministic guarantee that,
 * when TRACK1_TRENDING_WATCHLIST_FILTER is on, only tickers the user listed can be
 * matched (no LLM in the loop). Uses the real 149-token BSC list the user provided.
 */
describe("parseTrendingWatchlist", () => {
  // The real list lives in trending.ts as the baked-in default; reuse it here so the
  // parser tests and the default-watchlist behavior can never drift apart.
  const LIST = DEFAULT_TRENDING_WATCHLIST_RAW;

  it("extracts tickers from a 'search trending in this list:' message", () => {
    const set = parseTrendingWatchlist(
      `search trending cryptos in this list:\n${LIST}`,
    );
    expect(set.has("ETH")).toBe(true);
    expect(set.has("MYX")).toBe(true);
    expect(set.has("XAUM")).toBe(true);
  });

  it("uppercases mixed-case tickers and collapses case-duplicates", () => {
    const set = parseTrendingWatchlist(`list: ${LIST}`);
    // lisUSD/BabyDoge/USDf are stored uppercased so matching is case-insensitive.
    expect(set.has("LISUSD")).toBe(true);
    expect(set.has("BABYDOGE")).toBe(true);
    expect(set.has("USDF")).toBe(true); // USDf and USDF collapse to one entry
  });

  it("keeps digit-leading and unicode tickers", () => {
    const set = parseTrendingWatchlist(`list: ${LIST}`);
    expect(set.has("1INCH")).toBe(true);
    expect(set.has("0G")).toBe(true);
    expect(set.has("币安人生")).toBe(true);
  });

  it("de-dupes the repeated SLX (148 names → 146 unique symbols)", () => {
    const set = parseTrendingWatchlist(`list: ${LIST}`);
    // SLX and USDf/USDF are the two collisions in the source list.
    expect(set.size).toBe(146);
  });

  it("includes GRAM (TON's CMC alias) and excludes the dropped H/IP", () => {
    const set = parseTrendingWatchlist(`list: ${LIST}`);
    expect(set.has("TON")).toBe(true);
    expect(set.has("GRAM")).toBe(true);
    expect(set.has("H")).toBe(false);
    expect(set.has("IP")).toBe(false);
  });

  it("drops phrasing words that aren't tickers", () => {
    const set = parseTrendingWatchlist(
      "search the top trending coins in this list: ETH, MYX",
    );
    expect(set.has("SEARCH")).toBe(false);
    expect(set.has("TRENDING")).toBe(false);
    expect(set.has("LIST")).toBe(false);
    expect(set.has("ETH")).toBe(true);
    expect(set.has("MYX")).toBe(true);
  });

  it("returns an empty set when there is no list (filter stays off)", () => {
    expect(parseTrendingWatchlist("what's trending?").size).toBe(0);
    expect(parseTrendingWatchlist("show me the top 10 movers").size).toBe(0);
  });
});

/**
 * resolveTrendingWatchlist precedence: inline message list > TRACK1_TRENDING_WATCHLIST
 * env override > the baked-in default 146-token list. This is what lets a plain
 * "what's trending?" filter to the default list without re-pasting it each command.
 */
describe("resolveTrendingWatchlist", () => {
  const saved = process.env.TRACK1_TRENDING_WATCHLIST;
  afterEach(() => restoreEnv("TRACK1_TRENDING_WATCHLIST", saved));

  it("falls back to the default 146-token list when the message has no list", () => {
    delete process.env.TRACK1_TRENDING_WATCHLIST;
    const set = resolveTrendingWatchlist("what's trending?");
    expect(set.size).toBe(146);
    expect(set.has("ETH")).toBe(true);
    expect(set.has("MYX")).toBe(true);
  });

  it("an inline list in the message wins over the default", () => {
    delete process.env.TRACK1_TRENDING_WATCHLIST;
    const set = resolveTrendingWatchlist("trending in this list: BTC, SOL");
    expect(set.has("BTC")).toBe(true);
    expect(set.has("SOL")).toBe(true);
    expect(set.has("ETH")).toBe(false); // default list not consulted when an inline list exists
  });

  it("TRACK1_TRENDING_WATCHLIST overrides the default when no inline list", () => {
    process.env.TRACK1_TRENDING_WATCHLIST = "BTC, SOL, DOGE";
    const set = resolveTrendingWatchlist("what's trending?");
    expect(set.size).toBe(3);
    expect(set.has("BTC")).toBe(true);
    expect(set.has("ETH")).toBe(false);
  });
});

/**
 * Env-config tests for the two toggles: TRACK1_TRENDING_WATCHLIST_FILTER (the
 * on/off switch) and TRACK1_TRENDING_SEARCH_CAP (the fetch window). Verifies the
 * defaults, parsing, and clamping so the .env values behave as documented.
 */
describe("trending env config", () => {
  const savedFilter = process.env.TRACK1_TRENDING_WATCHLIST_FILTER;
  const savedCap = process.env.TRACK1_TRENDING_SEARCH_CAP;
  const savedDefault = process.env.TRENDING_DEFAULT_LIMIT;
  afterEach(() => {
    restoreEnv("TRACK1_TRENDING_WATCHLIST_FILTER", savedFilter);
    restoreEnv("TRACK1_TRENDING_SEARCH_CAP", savedCap);
    restoreEnv("TRENDING_DEFAULT_LIMIT", savedDefault);
  });

  it("watchlistFilterEnabled is OFF by default and only 'true' enables it", () => {
    delete process.env.TRACK1_TRENDING_WATCHLIST_FILTER;
    expect(watchlistFilterEnabled()).toBe(false); // unset → off (normal behavior)
    process.env.TRACK1_TRENDING_WATCHLIST_FILTER = "false";
    expect(watchlistFilterEnabled()).toBe(false);
    process.env.TRACK1_TRENDING_WATCHLIST_FILTER = "1";
    expect(watchlistFilterEnabled()).toBe(false); // only the literal "true" turns it on
    process.env.TRACK1_TRENDING_WATCHLIST_FILTER = "  TRUE ";
    expect(watchlistFilterEnabled()).toBe(true); // trimmed + case-insensitive
  });

  it("trendingSearchCap defaults to 30 and clamps to 1–100", () => {
    delete process.env.TRACK1_TRENDING_SEARCH_CAP;
    expect(trendingSearchCap()).toBe(30); // unset → code default
    process.env.TRACK1_TRENDING_SEARCH_CAP = "10";
    expect(trendingSearchCap()).toBe(10);
    process.env.TRACK1_TRENDING_SEARCH_CAP = "0";
    expect(trendingSearchCap()).toBe(1); // clamp low
    process.env.TRACK1_TRENDING_SEARCH_CAP = "500";
    expect(trendingSearchCap()).toBe(100); // clamp high
    process.env.TRACK1_TRENDING_SEARCH_CAP = "not-a-number";
    expect(trendingSearchCap()).toBe(30); // garbage → default
  });

  it("trendingDefaultLimit defaults to 10 and clamps to 1–100", () => {
    delete process.env.TRENDING_DEFAULT_LIMIT;
    expect(trendingDefaultLimit()).toBe(10); // unset → code default
    process.env.TRENDING_DEFAULT_LIMIT = "25";
    expect(trendingDefaultLimit()).toBe(25);
    process.env.TRENDING_DEFAULT_LIMIT = "0";
    expect(trendingDefaultLimit()).toBe(1); // clamp low
    process.env.TRENDING_DEFAULT_LIMIT = "500";
    expect(trendingDefaultLimit()).toBe(100); // clamp high
    process.env.TRENDING_DEFAULT_LIMIT = "not-a-number";
    expect(trendingDefaultLimit()).toBe(10); // garbage → default
  });
});

/**
 * Component test for the TRENDING handler — exercises the env toggle end-to-end with
 * CMC mocked, proving the OFF path is unchanged and the ON path drops off-list tokens
 * (the exact WIF/KGEN bug) and pulls the wider TRACK1_TRENDING_SEARCH_CAP window.
 */
describe("TRENDING handler (component)", () => {
  const savedFilter = process.env.TRACK1_TRENDING_WATCHLIST_FILTER;
  const savedCap = process.env.TRACK1_TRENDING_SEARCH_CAP;
  const savedDefault = process.env.TRENDING_DEFAULT_LIMIT;
  let spy: ReturnType<typeof spyOn> | undefined;

  // CMC feed: two of these (WIF, KGEN) are NOT in the user's list.
  const FEED = [
    { symbol: "ETH", name: "Ethereum", priceUsd: 3000, change24hPct: 1.2 },
    { symbol: "MYX", name: "MYX Finance", priceUsd: 0.108, change24hPct: 34.8 },
    { symbol: "WIF", name: "dogwifhat", priceUsd: 0.176, change24hPct: 16 },
    { symbol: "KGEN", name: "KGeN", priceUsd: 0.222, change24hPct: 22.3 },
  ];

  afterEach(() => {
    spy?.mockRestore();
    spy = undefined;
    restoreEnv("TRACK1_TRENDING_WATCHLIST_FILTER", savedFilter);
    restoreEnv("TRACK1_TRENDING_SEARCH_CAP", savedCap);
    restoreEnv("TRENDING_DEFAULT_LIMIT", savedDefault);
  });

  async function invoke(text: string) {
    const calls: number[] = [];
    spy = spyOn(CmcDataProvider.prototype, "getTrending").mockImplementation(
      async (n?: number) => {
        calls.push(n ?? -1);
        return FEED;
      },
    );
    let out = "";
    const result = await trendingAction.handler(
      createMockRuntime(),
      createMockMessage(text),
      createMockState(),
      {},
      async (c) => {
        out = c.text ?? "";
        return [];
      },
    );
    return { out, result, calls };
  }

  it("filter OFF → returns CMC's feed unchanged and ignores the cap", async () => {
    delete process.env.TRACK1_TRENDING_WATCHLIST_FILTER; // off
    delete process.env.TRENDING_DEFAULT_LIMIT;
    process.env.TRACK1_TRENDING_SEARCH_CAP = "30";
    const { out, calls } = await invoke(
      "search trending in this list: ETH, MYX",
    );
    expect(calls[0]).toBe(10); // uses the default message limit, NOT the cap
    expect(out).toContain("WIF"); // off-list tokens still shown when filter is off
    expect(out).toContain("KGEN");
    expect(out).not.toContain("(from your list)");
  });

  it("normal mode (no count, filter off) pulls TRENDING_DEFAULT_LIMIT from CMC", async () => {
    delete process.env.TRACK1_TRENDING_WATCHLIST_FILTER; // off
    process.env.TRENDING_DEFAULT_LIMIT = "15";
    const { calls } = await invoke("what's trending?");
    expect(calls[0]).toBe(15); // env default drives the fetch when no number is in the message
  });

  it("explicit count in the message still wins over TRENDING_DEFAULT_LIMIT", async () => {
    delete process.env.TRACK1_TRENDING_WATCHLIST_FILTER; // off
    process.env.TRENDING_DEFAULT_LIMIT = "15";
    const { calls } = await invoke("show me the top 5 trending");
    expect(calls[0]).toBe(5); // the "5" in the message overrides the env default
  });

  it("filter ON → keeps only listed tokens and pulls the cap window", async () => {
    process.env.TRACK1_TRENDING_WATCHLIST_FILTER = "true";
    process.env.TRACK1_TRENDING_SEARCH_CAP = "30";
    const { out, result } = await invoke(
      "search trending in this list: ETH, MYX",
    );
    expect(out).toContain("(from your list)");
    expect(out).toContain("ETH");
    expect(out).toContain("MYX");
    expect(out).not.toContain("WIF"); // off-list tokens dropped in code
    expect(out).not.toContain("KGEN");
    expect(result.values?.filtered).toBe(true);
  });

  it("filter ON + cap window is the value pulled from CMC", async () => {
    process.env.TRACK1_TRENDING_WATCHLIST_FILTER = "true";
    process.env.TRACK1_TRENDING_SEARCH_CAP = "25";
    const { calls } = await invoke("trending from list: ETH, MYX");
    expect(calls[0]).toBe(25);
  });

  it("filter ON but nothing in the list is trending → clear message", async () => {
    process.env.TRACK1_TRENDING_WATCHLIST_FILTER = "true";
    const { out, result } = await invoke("trending in this list: FOO, BAR");
    expect(out).toContain("None of the tokens in your list");
    expect(result.values?.count).toBe(0);
  });
});

function restoreEnv(key: string, saved: string | undefined) {
  if (saved === undefined) delete process.env[key];
  else process.env[key] = saved;
}
