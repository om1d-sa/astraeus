/**
 * Paper executor — a mock {@link Executor} for risk-free dry runs.
 *
 * Maintains an in-memory portfolio (a stablecoin cash leg + token holdings) and
 * simulates swaps with fee + slippage, returning fake tx hashes. Drop-in for the
 * real Trust Wallet Agent Kit executor: the autonomous loop is identical, only
 * the executor swaps out. Prices are supplied each tick via {@link mark}.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Executor, Portfolio, SwapRequest, SwapResult } from "./types";

export interface PaperExecutorOptions {
  startingCashUsd?: number;
  stableSymbol?: string;
  feeBps?: number;
  slippageBps?: number;
  /** If set, the paper portfolio (cash + holdings) is persisted here and reloaded on restart. */
  persistPath?: string;
}

export class PaperExecutor implements Executor {
  private cashUsd: number;
  private readonly stableSymbol: string;
  private readonly costRate: number;
  private readonly holdings = new Map<string, number>(); // symbol -> token amount
  private prices: Record<string, number> = {};
  private txSeq = 0;
  private readonly persistPath?: string;

  constructor(opts: PaperExecutorOptions = {}) {
    this.cashUsd = opts.startingCashUsd ?? 100;
    this.stableSymbol = opts.stableSymbol ?? "USDT";
    this.costRate = ((opts.feeBps ?? 10) + (opts.slippageBps ?? 20)) / 10_000;
    this.persistPath = opts.persistPath;
    this.load();
  }

  /** Restore a previously persisted portfolio (no-op if no file / not configured). */
  private load(): void {
    if (!this.persistPath || !existsSync(this.persistPath)) return;
    try {
      const data = JSON.parse(readFileSync(this.persistPath, "utf8")) as {
        cashUsd?: number;
        holdings?: { symbol: string; amount: number }[];
      };
      if (typeof data.cashUsd === "number") this.cashUsd = data.cashUsd;
      for (const h of data.holdings ?? []) {
        if (
          h &&
          typeof h.symbol === "string" &&
          typeof h.amount === "number" &&
          h.amount > 0
        ) {
          this.holdings.set(h.symbol, h.amount);
        }
      }
    } catch {
      /* corrupt/unreadable — keep starting state */
    }
  }

  /** Persist cash + holdings so a restart resumes the same portfolio. */
  private save(): void {
    if (!this.persistPath) return;
    try {
      mkdirSync(dirname(this.persistPath), { recursive: true });
      writeFileSync(
        this.persistPath,
        JSON.stringify(
          {
            cashUsd: this.cashUsd,
            holdings: [...this.holdings.entries()].map(([symbol, amount]) => ({
              symbol,
              amount,
            })),
          },
          null,
          2,
        ),
      );
    } catch {
      /* best-effort; never break trading on a disk error */
    }
  }

  /** Update the mark prices used to value holdings and fill swaps. */
  mark(prices: Record<string, number>): void {
    this.prices = { ...this.prices, ...prices };
  }

  private isStable(symbol: string): boolean {
    return symbol === this.stableSymbol;
  }

  async getPortfolio(): Promise<Portfolio> {
    const holdings = [...this.holdings.entries()]
      .filter(([, amount]) => amount > 0)
      .map(([symbol, amount]) => ({
        symbol,
        amount,
        valueUsd: amount * (this.prices[symbol] ?? 0),
      }));
    const holdingsValue = holdings.reduce((s, h) => s + h.valueUsd, 0);
    return {
      totalValueUsd: this.cashUsd + holdingsValue,
      cashUsd: this.cashUsd,
      holdings,
    };
  }

  async swap(req: SwapRequest): Promise<SwapResult> {
    const buying =
      this.isStable(req.fromSymbol) && !this.isStable(req.toSymbol);
    const selling =
      !this.isStable(req.fromSymbol) && this.isStable(req.toSymbol);

    if (buying) {
      const price = this.prices[req.toSymbol];
      if (!price) return { ok: false, error: `no price for ${req.toSymbol}` };
      if (req.amountUsd > this.cashUsd + 1e-9)
        return { ok: false, error: "insufficient cash" };
      const amount = (req.amountUsd * (1 - this.costRate)) / price;
      this.cashUsd -= req.amountUsd;
      this.holdings.set(
        req.toSymbol,
        (this.holdings.get(req.toSymbol) ?? 0) + amount,
      );
      this.save();
      return { ok: true, txHash: this.fakeHash(), filledUsd: req.amountUsd };
    }

    if (selling) {
      const price = this.prices[req.fromSymbol];
      if (!price) return { ok: false, error: `no price for ${req.fromSymbol}` };
      const have = this.holdings.get(req.fromSymbol) ?? 0;
      const sellAmount = Math.min(have, req.amountUsd / price);
      if (sellAmount <= 0)
        return { ok: false, error: `no ${req.fromSymbol} to sell` };
      const proceeds = sellAmount * price * (1 - this.costRate);
      this.cashUsd += proceeds;
      const left = have - sellAmount;
      if (left > 1e-12) this.holdings.set(req.fromSymbol, left);
      else this.holdings.delete(req.fromSymbol);
      this.save();
      return { ok: true, txHash: this.fakeHash(), filledUsd: proceeds };
    }

    return {
      ok: false,
      error: `unsupported pair ${req.fromSymbol}->${req.toSymbol}`,
    };
  }

  async registerForCompetition(): Promise<SwapResult> {
    return { ok: true, txHash: `0xpaper-register-${Date.now().toString(16)}` };
  }

  private fakeHash(): string {
    this.txSeq += 1;
    return `0xpaper${this.txSeq.toString(16).padStart(4, "0")}`;
  }
}
