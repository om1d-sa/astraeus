/**
 * TwakExecutor — live {@link Executor} backed by the Trust Wallet Agent Kit CLI.
 *
 * Shells out to the `twak` binary in Agent Wallet mode: self-custody signing with
 * the key held in the OS keychain. The wallet password / private key never pass
 * through this process — TWAK reads them from the keychain itself.
 *
 * Drop-in replacement for {@link PaperExecutor}; the autonomous loop is unchanged.
 *   getPortfolio()           -> twak wallet balance --chain bsc --json
 *   swap(req)                -> twak swap <from> <to> --usd <amt> --chain bsc --slippage <pct> --json
 *   registerForCompetition() -> twak compete register --json
 *
 * NOTE: TWAK's *success* JSON field names are mapped defensively (multiple
 * candidate keys per field). After the first real funded run, confirm the field
 * names against actual output and tighten the `pick*` calls if needed.
 */
import {
  runTwak,
  asRecord,
  firstArray,
  pickNumber,
  pickString,
  truncate,
} from "./twakCli";
import type {
  Executor,
  Holding,
  Portfolio,
  SwapRequest,
  SwapResult,
} from "./types";

const num = (key: string, fallback: number): number => {
  const v = process.env[key];
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
};
const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/**
 * Whether a swap error is a TRANSIENT upstream/network blip worth retrying — and NOT a
 * real on-chain revert (tx already cost gas) or an auth/funds problem (retrying can't
 * fix those). TWAK labels its flaky price-service hiccups "NETWORK_ERROR" / "unable to
 * fetch price"; those happen BEFORE any tx is sent, so retrying is safe and free.
 */
export function isTransientSwapError(msg: string): boolean {
  const m = msg.toLowerCase();
  if (
    /reverted|claim tokens|approval_sent|tx_failed|forbidden|403|api key|unauthorized|insufficient/.test(
      m,
    )
  )
    return false;
  return /network_error|unable to fetch|could not fetch|fail(?:ed)? to fetch|fetch failed|try again|timeout|timed out|econnreset|etimedout|enotfound|eai_again|socket hang up|temporar|rate.?limit/.test(
    m,
  );
}

export interface TwakExecutorOptions {
  /** TWAK chain key (default 'bsc' — BNB Smart Chain). */
  chain?: string;
  /** Stablecoin treated as the cash leg (default 'USDT'). */
  stableSymbol?: string;
  /** twak binary name/path (default 'twak', overridable via TWAK_BIN). */
  bin?: string;
  /** Per-command timeout in ms (default 120000). */
  timeoutMs?: number;
  /** Fallback slippage % when a request doesn't set one (default 1). */
  defaultSlippagePct?: number;
  /**
   * Prefer a token's on-chain CONTRACT ADDRESS over its ticker when the request supplies
   * one (see {@link SwapRequest.toAddress}). BSC tickers like M/B/U/NFT/REAL collide across
   * chains, so TWAK can route the wrong token (or fail) when given just the symbol — the
   * address is unambiguous. Default ON; set TRACK1_ALTCOIN_USE_CONTRACT=false to force symbols.
   */
  useContract?: boolean;
}

/** The token identifier to hand TWAK for one swap leg: the contract address when we have
 *  one and `useContract` is on (unambiguous on-chain), else the ticker. Pure + testable. */
export function tokenArg(
  symbol: string,
  address: string | undefined,
  useContract: boolean,
): string {
  return useContract && address && address.trim() ? address.trim() : symbol;
}

/** Build the `twak swap …` argv for a request. Pure (no I/O) so the symbol-vs-contract
 *  routing — the exact thing that breaks live altcoin swaps — is unit-testable. */
export function buildSwapArgs(
  req: SwapRequest,
  opts: { chain: string; slippagePct: number; useContract: boolean },
): string[] {
  return [
    "swap",
    tokenArg(req.fromSymbol, req.fromAddress, opts.useContract),
    tokenArg(req.toSymbol, req.toAddress, opts.useContract),
    "--usd",
    String(req.amountUsd),
    "--chain",
    opts.chain,
    "--slippage",
    String(opts.slippagePct),
    "--json",
  ];
}

export class TwakExecutor implements Executor {
  private readonly chain: string;
  private readonly stableSymbol: string;
  private readonly bin: string;
  private readonly timeoutMs: number;
  private readonly defaultSlippagePct: number;
  private readonly useContract: boolean;

  constructor(opts: TwakExecutorOptions = {}) {
    this.chain = opts.chain ?? "bsc";
    this.stableSymbol = (opts.stableSymbol ?? "USDT").toUpperCase();
    this.bin = opts.bin ?? process.env.TWAK_BIN ?? "twak";
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.defaultSlippagePct = opts.defaultSlippagePct ?? 1;
    // Default ON: prefer the contract address for chain-ambiguous altcoin tickers.
    // Trim before comparing so a padded "  false  " disables routing here exactly as it
    // does in altcoinUseContract() — the two reads must not diverge on whitespace.
    this.useContract =
      opts.useContract ??
      (process.env.TRACK1_ALTCOIN_USE_CONTRACT ?? "true").trim().toLowerCase() !==
        "false";
  }

  /** No-op: TWAK resolves real prices on-chain. Kept for PaperExecutor parity. */
  mark(_prices: Record<string, number>): void {
    /* intentionally empty */
  }

  private run(args: string[], timeoutMs: number = this.timeoutMs) {
    return runTwak(args, { bin: this.bin, timeoutMs });
  }

  async getPortfolio(): Promise<Portfolio> {
    const { json } = await this.run([
      "wallet",
      "balance",
      "--chain",
      this.chain,
      "--json",
    ]);
    const obj = asRecord(json);
    if (obj.error || obj.errorCode) {
      throw new Error(
        `twak balance error: ${String(obj.error ?? obj.errorCode)}`,
      );
    }

    const list =
      firstArray(obj, ["tokens", "holdings", "balances", "assets"]) ?? [];
    const holdings: Holding[] = [];
    let cashUsd = 0;

    // Native (BNB) leg, if reported separately.
    const native = asRecord(obj.native ?? obj.nativeBalance);
    if (Object.keys(native).length) {
      const amount = pickNumber(native, ["amount", "balance", "value"]) ?? 0;
      const valueUsd =
        pickNumber(native, ["valueUsd", "usdValue", "fiatValue"]) ?? 0;
      const symbol = String(native.symbol ?? "BNB").toUpperCase();
      if (amount > 0) holdings.push({ symbol, amount, valueUsd });
    }

    for (const raw of list) {
      const t = asRecord(raw);
      const symbol = String(t.symbol ?? t.ticker ?? "").toUpperCase();
      if (!symbol) continue;
      const amount =
        pickNumber(t, ["amount", "balance", "uiAmount", "value"]) ?? 0;
      const valueUsd =
        pickNumber(t, ["valueUsd", "usdValue", "fiatValue"]) ?? 0;
      const address =
        typeof t.address === "string"
          ? t.address
          : typeof t.contract === "string"
            ? t.contract
            : undefined;
      if (symbol === this.stableSymbol) {
        cashUsd += valueUsd || amount; // stablecoin ≈ $1
      } else if (amount > 0) {
        holdings.push({ symbol, address, amount, valueUsd });
      }
    }

    const holdingsValue = holdings.reduce((s, h) => s + h.valueUsd, 0);
    const totalValueUsd =
      pickNumber(obj, ["totalValueUsd", "totalUsd"]) ?? cashUsd + holdingsValue;
    return { totalValueUsd, cashUsd, holdings };
  }

  async swap(req: SwapRequest): Promise<SwapResult> {
    const slippagePct =
      req.maxSlippageBps > 0
        ? req.maxSlippageBps / 100
        : this.defaultSlippagePct;
    // Hand TWAK the contract address for altcoins (tickers collide across chains), the
    // ticker for the stable cash leg. buildSwapArgs decides per leg from req.*Address.
    const args = buildSwapArgs(req, {
      chain: this.chain,
      slippagePct,
      useContract: this.useContract,
    });
    // TWAK's price/quote upstream is intermittently flaky (NETWORK_ERROR / "unable to
    // fetch price") BEFORE any tx is sent — so retry transient blips. Real reverts and
    // auth/funds errors are NOT retried (isTransientSwapError filters them out).
    // A live swap is TWO sequential on-chain txs (ERC-20 approval, then the swap) routed
    // through an aggregator — far slower than a read (~200s observed on BSC), so it gets a
    // dedicated, longer budget than the executor's default read timeout.
    const swapTimeoutMs = num("TWAK_SWAP_TIMEOUT_MS", 240_000);
    const maxAttempts = Math.max(1, num("TWAK_SWAP_RETRIES", 10));
    const retryDelayMs = num("TWAK_SWAP_RETRY_MS", 2000);
    let lastErr = "swap failed";
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let json: unknown;
      let raw: string;
      try {
        ({ json, raw } = await this.run(args, swapTimeoutMs));
      } catch (e) {
        // run() throws ONLY when twak produced no stdout — i.e. the process was killed
        // (timeout) or crashed, possibly AFTER broadcasting the swap tx. We must NOT retry
        // here: a retry could double-execute the buy. Surface it as a graceful failure
        // (not an exception) so the caller handles it via its pre-trade stray-ETH sweep,
        // which reconciles any phantom fill on the next cycle.
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
      const obj = asRecord(json);
      if (obj.error || obj.errorCode) {
        lastErr = String(obj.error ?? obj.errorCode);
        if (attempt < maxAttempts && isTransientSwapError(lastErr)) {
          await sleep(retryDelayMs); // transient blip, no tx sent — try again
          continue;
        }
        return { ok: false, error: lastErr };
      }
      const txHash = pickString(obj, [
        "txHash",
        "hash",
        "transactionHash",
        "txid",
        "tx",
      ]);
      if (!txHash) {
        // No error but no hash — ambiguous; do NOT retry (a tx may have been sent).
        return {
          ok: false,
          error: `swap returned no tx hash: ${truncate(raw, 200)}`,
        };
      }
      const filledUsd =
        pickNumber(obj, ["filledUsd", "amountUsd", "usd"]) ?? req.amountUsd;
      return { ok: true, txHash, filledUsd };
    }
    return { ok: false, error: lastErr };
  }

  async registerForCompetition(): Promise<SwapResult> {
    const { json, raw } = await this.run(["compete", "register", "--json"]);
    const obj = asRecord(json);
    if (obj.error || obj.errorCode) {
      return { ok: false, error: String(obj.error ?? obj.errorCode) };
    }
    const txHash = pickString(obj, ["txHash", "hash", "transactionHash"]);
    // Treat an explicit registered:true, or a returned tx hash, as success.
    if (obj.registered === true || txHash) {
      return { ok: true, txHash };
    }
    return {
      ok: false,
      error: `registration not confirmed: ${truncate(raw, 200)}`,
    };
  }
}
