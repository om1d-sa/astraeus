/**
 * Shared forecast enrichment — the SAME bounded, toggle-managed, best-effort CMC
 * context used by both the autonomous loop AND the manual OPTIONS_FORECAST action.
 *
 * Sources (all parallel, each bounded by its own timeout, all skip-on-failure):
 *   - CMC options-positioning (Skill Hub MCP) — "source 7"   [CMC_OPTIONS_ENRICH]
 *   - CMC technicals / regime / price / Fear & Greed (REST)  [CMC_ENRICH]
 *   - x402-paid premium signal(s)                            [X402_ENRICH]
 *
 * The options/derivatives data inside generateForecast stays the PRIMARY ~60% basis;
 * this is the supplementary ~40%. None of this can throw or stall the forecast.
 */
import { type IAgentRuntime, logger } from "@elizaos/core";
import type { CmcDataProvider } from "../../data/cmc";
import { fetchCmcOptionsContext } from "./cmc-context";
import { fetchCmcForecastContext } from "./cmc-enrich";
import { runSkillBundle, skillList, DEFAULT_ETF_SKILLS } from "./skill-bundle";
import { requestX402 } from "../../exec/x402";
import { truncate } from "../../exec/twakCli";

const num = (key: string, fallback: number): number => {
  const v = process.env[key];
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
};

/** Race a promise against a hard, unref'd timeout; resolves undefined on timeout. */
function raceTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  const TIMEOUT = "__enrich_timeout__" as const;
  const guard = new Promise<typeof TIMEOUT>((resolve) => {
    const t = setTimeout(() => resolve(TIMEOUT), ms);
    (t as { unref?: () => void }).unref?.();
  });
  return Promise.race([p, guard]).then((r) =>
    r === TIMEOUT ? undefined : (r as T),
  );
}

/** CMC options-positioning ("source 7"). Forced by manual "cmc", else CMC_OPTIONS_ENRICH≠false. */
export async function fetchCmcOptionsEnrichment(
  rt: IAgentRuntime,
  asset: string,
  force: boolean,
): Promise<string | undefined> {
  const on =
    force ||
    (process.env.CMC_OPTIONS_ENRICH ?? "true").toLowerCase() !== "false";
  if (!on) return undefined;
  try {
    const result = await raceTimeout(
      fetchCmcOptionsContext(rt, asset),
      num("CMC_OPTIONS_TIMEOUT_MS", 30_000),
    );
    return result || undefined;
  } catch (e) {
    logger.warn(
      { err: String(e) },
      "CMC options-positioning skipped — using base data",
    );
    return undefined;
  }
}

/** CMC technicals / regime / price / Fear & Greed (REST). On by default (CMC_ENRICH≠false). */
export async function fetchCmcRestEnrichment(
  provider: CmcDataProvider | null | undefined,
  asset: string,
): Promise<string | undefined> {
  if ((process.env.CMC_ENRICH ?? "true").toLowerCase() === "false")
    return undefined;
  if (!provider) return undefined;
  try {
    const result = await raceTimeout(
      fetchCmcForecastContext(provider, asset),
      num("CMC_ENRICH_TIMEOUT_MS", 12_000),
    );
    return result?.context;
  } catch (e) {
    logger.warn({ err: String(e) }, "CMC enrichment skipped — using base data");
    return undefined;
  }
}

/**
 * Compact a x402 payload for the forecast prompt. CoinMarketCap's quotes endpoint
 * returns a big JSON object (a `data` array of every token sharing the ticker — the
 * real asset plus dozens of same-symbol memecoins — each with ~40 tags) whose actual
 * price sits far past any sane truncation. So when the body parses as a CMC quotes
 * response, pull just the primary token's price + key changes; otherwise fall back to
 * a (generous) truncation of the raw text.
 */
export function summarizeX402Payload(text: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return truncate(text, 2000);
  }
  const root = parsed as { data?: unknown };
  const arr: Array<Record<string, unknown>> = Array.isArray(root?.data)
    ? (root.data as Array<Record<string, unknown>>)
    : Array.isArray(parsed)
      ? (parsed as Array<Record<string, unknown>>)
      : root?.data && typeof root.data === "object"
        ? [root.data as Record<string, unknown>]
        : [];
  if (arr.length === 0) return truncate(text, 2000);

  // CMC x402 v3 returns `quote` as an array [{symbol:"USD",…}]; REST v1 as {USD:{…}}.
  const usdQuote = (
    e: Record<string, unknown>,
  ): Record<string, unknown> | undefined => {
    const q = e.quote;
    if (Array.isArray(q))
      return (q.find(
        (x) => (x as { symbol?: string })?.symbol === "USD",
      ) ?? q[0]) as Record<string, unknown> | undefined;
    if (q && typeof q === "object")
      return ((q as Record<string, unknown>).USD ?? q) as Record<string, unknown>;
    return undefined;
  };
  const priceOf = (e: Record<string, unknown>): number | undefined => {
    const p = usdQuote(e)?.price;
    return typeof p === "number" && Number.isFinite(p) ? p : undefined;
  };
  // Primary token = the real asset: a live USD price, lowest cmc_rank (nulls last) —
  // this discards the same-ticker memecoins, which have null rank and null price.
  const top = arr
    .filter((e) => priceOf(e) !== undefined)
    .sort((a, b) => {
      const ra = typeof a.cmc_rank === "number" ? a.cmc_rank : Number.MAX_SAFE_INTEGER;
      const rb = typeof b.cmc_rank === "number" ? b.cmc_rank : Number.MAX_SAFE_INTEGER;
      return ra - rb;
    })[0];
  if (!top) return truncate(text, 2000);

  const q = usdQuote(top) ?? {};
  const sym = String(top.symbol ?? top.name ?? "?");
  const price = priceOf(top) as number;
  const pct = (k: string): string => {
    const v = q[k];
    return typeof v === "number" ? `${v >= 0 ? "+" : ""}${v.toFixed(2)}%` : "n/a";
  };
  const vol =
    typeof q.volume_24h === "number"
      ? ` vol24h $${(q.volume_24h / 1e9).toFixed(2)}B`
      : "";
  const mcap =
    typeof q.market_cap === "number" && q.market_cap > 0
      ? ` mcap $${(q.market_cap / 1e9).toFixed(0)}B`
      : "";
  return `${sym} $${price.toFixed(2)} (1h ${pct("percent_change_1h")}, 24h ${pct("percent_change_24h")}, 7d ${pct("percent_change_7d")})${vol}${mcap}`;
}

/** x402-paid premium signal(s). OFF unless X402_ENRICH=true. Parallel + bounded per endpoint. */
export async function fetchX402Enrichment(): Promise<string | undefined> {
  if ((process.env.X402_ENRICH ?? "").toLowerCase() !== "true")
    return undefined;
  const urls = (process.env.X402_DATA_URL ?? "")
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);
  if (urls.length === 0) return undefined;
  const timeoutMs = num("X402_ENRICH_TIMEOUT_MS", 15_000);
  // requestX402 may retry a transient "fetch failed" up to X402_RETRIES times;
  // widen the overall guard so a retry isn't cut off mid-flight.
  const attempts = Math.max(1, num("X402_RETRIES", 2));

  const fetchOne = async (url: string): Promise<string | undefined> => {
    try {
      const r = await raceTimeout(
        requestX402(url, { timeoutMs }),
        timeoutMs * attempts + 1_000,
      );
      if (!r || !r.ok || !(r.body ?? r.raw)) {
        logger.warn(
          { url, err: r?.error ?? "timeout" },
          "x402 endpoint skipped",
        );
        return undefined;
      }
      logger.info(
        { url, paid: r.paid, txHash: r.txHash },
        "x402 enrichment fetched",
      );
      return `[${url}]\n${summarizeX402Payload(r.body ?? r.raw)}`;
    } catch (e) {
      logger.warn({ url, err: String(e) }, "x402 endpoint errored — skipped");
      return undefined;
    }
  };

  const parts = (await Promise.all(urls.map(fetchOne))).filter(
    (p): p is string => Boolean(p),
  );
  if (parts.length === 0) return undefined;
  return `X402-PAID PREMIUM SIGNALS (via TWAK):\n${parts.join("\n---\n")}`;
}

/**
 * Gather all supplementary forecast context in PARALLEL (total latency ≈ the slowest,
 * not the sum). Never throws, never stalls the forecast.
 */
export async function gatherForecastEnrichment(
  rt: IAgentRuntime,
  provider: CmcDataProvider | null | undefined,
  asset: string,
  forceCmcOptions = false,
): Promise<string | undefined> {
  // ETF-flow skills only apply to BTC/ETH (no spot ETF for BNB). Gated by the
  // CMC_SKILLS_ENABLED master toggle (slow), so off by default.
  const wantEtf = asset === "BTC" || asset === "ETH";
  const [opt, cmc, x402, etf] = await Promise.all([
    fetchCmcOptionsEnrichment(rt, asset, forceCmcOptions),
    fetchCmcRestEnrichment(provider, asset),
    fetchX402Enrichment(),
    wantEtf
      ? runSkillBundle(
          rt,
          skillList("FORECAST_ETF_SKILLS", DEFAULT_ETF_SKILLS),
          {
            symbol: asset,
          },
        )
      : Promise.resolve(undefined),
  ]);
  return [opt, cmc, x402, etf].filter(Boolean).join("\n\n") || undefined;
}
