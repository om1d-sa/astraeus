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
  return /network_error|unable to fetch|could not fetch|try again|timeout|timed out|econnreset|etimedout|temporar|rate.?limit/.test(
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
}

export class TwakExecutor implements Executor {
  private readonly chain: string;
  private readonly stableSymbol: string;
  private readonly bin: string;
  private readonly timeoutMs: number;
  private readonly defaultSlippagePct: number;

  constructor(opts: TwakExecutorOptions = {}) {
    this.chain = opts.chain ?? "bsc";
    this.stableSymbol = (opts.stableSymbol ?? "USDT").toUpperCase();
    this.bin = opts.bin ?? process.env.TWAK_BIN ?? "twak";
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.defaultSlippagePct = opts.defaultSlippagePct ?? 1;
  }

  /** No-op: TWAK resolves real prices on-chain. Kept for PaperExecutor parity. */
  mark(_prices: Record<string, number>): void {
    /* intentionally empty */
  }

  private run(args: string[]) {
    return runTwak(args, { bin: this.bin, timeoutMs: this.timeoutMs });
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
    const args = [
      "swap",
      req.fromSymbol,
      req.toSymbol,
      "--usd",
      String(req.amountUsd),
      "--chain",
      this.chain,
      "--slippage",
      String(slippagePct),
      "--json",
    ];
    // TWAK's price/quote upstream is intermittently flaky (NETWORK_ERROR / "unable to
    // fetch price") BEFORE any tx is sent — so retry transient blips. Real reverts and
    // auth/funds errors are NOT retried (isTransientSwapError filters them out).
    const maxAttempts = Math.max(1, num("TWAK_SWAP_RETRIES", 10));
    const retryDelayMs = num("TWAK_SWAP_RETRY_MS", 2000);
    let lastErr = "swap failed";
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const { json, raw } = await this.run(args);
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
