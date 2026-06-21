import { describe, expect, it } from "bun:test";
import { resumeDelayMs, isLiveTradeBlocked } from "../agent/service";

/**
 * Restart-safety for the loop + Track-1 heartbeat cadence. `resumeDelayMs` is the pure
 * core: given a persisted next-fire time, how long to wait after a restart so downtime
 * doesn't corrupt the schedule (and the 18h heartbeat isn't reset to a fresh 18h on
 * every restart — which previously could starve it and miss the daily-trade guarantee).
 */
describe("resumeDelayMs", () => {
  const now = 1_000_000;

  it("uses the fallback when there is no (or a bad) saved time — fresh start", () => {
    expect(
      resumeDelayMs(undefined, { fallbackMs: 5000, overdueMs: 0, capMs: 9999, now }),
    ).toBe(5000);
    expect(
      resumeDelayMs(NaN, { fallbackMs: 5000, overdueMs: 0, capMs: 9999, now }),
    ).toBe(5000);
  });

  it("fires a catch-up when the saved time already passed (agent was down)", () => {
    expect(
      resumeDelayMs(now - 1, {
        fallbackMs: 5000,
        overdueMs: 30_000,
        capMs: 9_999_999,
        now,
      }),
    ).toBe(30_000);
    // overdueMs 0 = run immediately (the main-loop catch-up case).
    expect(
      resumeDelayMs(now - 10_000_000, {
        fallbackMs: 5000,
        overdueMs: 0,
        capMs: 100,
        now,
      }),
    ).toBe(0);
  });

  it("waits only the REMAINING time when the fire is still in the future", () => {
    expect(
      resumeDelayMs(now + 6_000, {
        fallbackMs: 999,
        overdueMs: 0,
        capMs: 60_000,
        now,
      }),
    ).toBe(6_000);
  });

  it("caps the remaining wait at capMs (never longer than one interval)", () => {
    expect(
      resumeDelayMs(now + 100_000, {
        fallbackMs: 0,
        overdueMs: 0,
        capMs: 60_000,
        now,
      }),
    ).toBe(60_000);
  });

  it("models the heartbeat surviving frequent restarts (no reset-to-18h starvation)", () => {
    const interval = 64_800_000; // 18h
    const opts = { fallbackMs: interval, overdueMs: 30_000, capMs: interval };
    const dueAt = now + interval; // scheduled 18h out on first start
    // Restart 2h later: it must wait the REMAINING ~16h, not a fresh 18h.
    expect(resumeDelayMs(dueAt, { ...opts, now: now + 2 * 3_600_000 })).toBe(
      interval - 2 * 3_600_000,
    );
    // Restart after the due time passed: fire the catch-up soon.
    expect(resumeDelayMs(dueAt, { ...opts, now: dueAt + 5 })).toBe(30_000);
  });
});

describe("isLiveTradeBlocked (live-mode BTC/BNB guard)", () => {
  it("never blocks in paper mode (any asset)", () => {
    expect(isLiveTradeBlocked("paper", "BTC", "true")).toBe(false);
    expect(isLiveTradeBlocked("paper", "BNB", undefined)).toBe(false);
  });

  it("never blocks ETH, even in live mode", () => {
    expect(isLiveTradeBlocked("live", "ETH", "true")).toBe(false);
  });

  it("blocks BTC/BNB in live mode by default (toggle unset)", () => {
    expect(isLiveTradeBlocked("live", "BTC", undefined)).toBe(true);
    expect(isLiveTradeBlocked("live", "BNB", undefined)).toBe(true);
    expect(isLiveTradeBlocked("live", "BTC", "true")).toBe(true);
  });

  it("allows live BTC/BNB only when the toggle is explicitly false", () => {
    expect(isLiveTradeBlocked("live", "BTC", "false")).toBe(false);
    expect(isLiveTradeBlocked("live", "BNB", "FALSE")).toBe(false);
  });
});
