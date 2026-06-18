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
    const { json, raw } = await this.run([
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
    ]);
    const obj = asRecord(json);
    if (obj.error || obj.errorCode) {
      return { ok: false, error: String(obj.error ?? obj.errorCode) };
    }
    const txHash = pickString(obj, [
      "txHash",
      "hash",
      "transactionHash",
      "txid",
      "tx",
    ]);
    if (!txHash) {
      return {
        ok: false,
        error: `swap returned no tx hash: ${truncate(raw, 200)}`,
      };
    }
    const filledUsd =
      pickNumber(obj, ["filledUsd", "amountUsd", "usd"]) ?? req.amountUsd;
    return { ok: true, txHash, filledUsd };
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
