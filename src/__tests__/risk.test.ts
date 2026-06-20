import { describe, expect, it } from "bun:test";
import {
  checkGuardrails,
  type RiskConfig,
  type GuardrailContext,
} from "../config/risk";

/**
 * Risk-guardrail tests. checkGuardrails is the pre-trade gate now wired into the
 * LIVE trading loop (service.ts) — these lock in the money-safety behavior:
 * drawdown halt, daily trade/volume caps, token allowlist, conviction floor.
 */

const cfg: RiskConfig = {
  maxDrawdownPct: 10,
  maxTradeUsd: 5,
  maxTradesPerDay: 2,
  maxDailyVolumeUsd: 10,
  minTradesPerDay: 1,
  maxSlippageBps: 100,
  minConviction: 60,
  minCashReservePct: 0,
};

const ok: GuardrailContext = {
  conviction: 70,
  tradeUsd: 5,
  currentDrawdownPct: 2,
  tradesToday: 0,
  volumeTodayUsd: 0,
  tokenSymbol: "ETH",
  isTokenEligible: true,
};

describe("checkGuardrails", () => {
  it("allows a clean, in-bounds trade", () => {
    expect(checkGuardrails(ok, cfg).allowed).toBe(true);
  });

  it("HALTS when drawdown reaches the cap (DQ protection)", () => {
    const d = checkGuardrails({ ...ok, currentDrawdownPct: 10 }, cfg);
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain("drawdown");
  });

  it("blocks a token not on the eligible allowlist", () => {
    const d = checkGuardrails(
      { ...ok, tokenSymbol: "SCAM", isTokenEligible: false },
      cfg,
    );
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain("allowlist");
  });

  it("blocks below the conviction floor", () => {
    expect(checkGuardrails({ ...ok, conviction: 59 }, cfg).allowed).toBe(false);
  });

  it("blocks an oversized trade", () => {
    expect(checkGuardrails({ ...ok, tradeUsd: 6 }, cfg).allowed).toBe(false);
  });

  it("blocks once the daily trade count is hit", () => {
    const d = checkGuardrails({ ...ok, tradesToday: 2 }, cfg);
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain("daily trade count");
  });

  it("blocks when the trade would exceed the daily volume cap", () => {
    const d = checkGuardrails({ ...ok, volumeTodayUsd: 6 }, cfg); // 6 + 5 > 10
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain("daily volume");
  });
});
