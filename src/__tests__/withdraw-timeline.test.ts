import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_WITHDRAW_TIMELINE_MS,
  TIMEFRAME_MS,
  WITHDRAW_TIMELINE_ENV,
  customWithdrawTimelineMs,
  hasCustomWithdrawTimeline,
  parseDurationMs,
  withdrawTimelineEnabled,
  withdrawTimelineMs,
} from "../skills/withdraw/timeline";
import { TradingService } from "../agent/service";
import { CmcDataProvider } from "../data/cmc";
import { createMockRuntime } from "./utils/core-test-utils";

function restoreEnv(key: string, saved: string | undefined) {
  if (saved === undefined) delete process.env[key];
  else process.env[key] = saved;
}

/** The duration parser: human units (s/m/h/d/w) or bare milliseconds, else undefined. */
describe("parseDurationMs", () => {
  it("parses unit-suffixed durations", () => {
    expect(parseDurationMs("45s")).toBe(45_000);
    expect(parseDurationMs("30m")).toBe(1_800_000);
    expect(parseDurationMs("8h")).toBe(28_800_000);
    expect(parseDurationMs("3d")).toBe(259_200_000);
    expect(parseDurationMs("2w")).toBe(1_209_600_000);
    expect(parseDurationMs("250ms")).toBe(250);
    expect(parseDurationMs("1.5h")).toBe(5_400_000);
    expect(parseDurationMs("  8H ")).toBe(28_800_000); // trims + case-insensitive
  });

  it("treats a bare number as milliseconds", () => {
    expect(parseDurationMs("1800000")).toBe(1_800_000);
    expect(parseDurationMs("1")).toBe(1);
  });

  it("rejects blank / zero / negative / garbage", () => {
    for (const bad of [
      undefined,
      "",
      "   ",
      "0",
      "0h",
      "-5",
      "8 hours",
      "abc",
      "h8",
      "8x",
    ]) {
      expect(parseDurationMs(bad)).toBeUndefined();
    }
  });
});

/**
 * The per-loop withdraw-timeline core: an ON/OFF switch + a duration value. The override is
 * effective ONLY when the switch is on AND the value parses; the value is inert on its own.
 * The two loops read INDEPENDENT env vars so one can never bleed into the other.
 */
describe("withdraw-timeline env config", () => {
  const KEYS = [
    WITHDRAW_TIMELINE_ENV.main.enabled,
    WITHDRAW_TIMELINE_ENV.main.value,
    WITHDRAW_TIMELINE_ENV.alt.enabled,
    WITHDRAW_TIMELINE_ENV.alt.value,
  ];
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  afterEach(() => {
    for (const k of KEYS) restoreEnv(k, saved[k]);
  });

  function setMain(enabled: string | undefined, value: string | undefined) {
    restoreEnv(WITHDRAW_TIMELINE_ENV.main.enabled, enabled);
    restoreEnv(WITHDRAW_TIMELINE_ENV.main.value, value);
  }
  function setAlt(enabled: string | undefined, value: string | undefined) {
    restoreEnv(WITHDRAW_TIMELINE_ENV.alt.enabled, enabled);
    restoreEnv(WITHDRAW_TIMELINE_ENV.alt.value, value);
  }

  it("switch defaults OFF; only the literal 'true' enables it", () => {
    setMain(undefined, "3d");
    expect(withdrawTimelineEnabled("main")).toBe(false);
    setMain("1", "3d");
    expect(withdrawTimelineEnabled("main")).toBe(false);
    setMain("  TRUE ", "3d");
    expect(withdrawTimelineEnabled("main")).toBe(true);
  });

  it("falls back to the timeframe default when the switch is OFF (even with a value set)", () => {
    setMain("false", "3d");
    expect(customWithdrawTimelineMs("main")).toBeUndefined();
    expect(hasCustomWithdrawTimeline("main")).toBe(false);
    expect(withdrawTimelineMs("main", "daily")).toBe(TIMEFRAME_MS.daily);
  });

  it("falls back to the timeframe default when ON but the value is blank/invalid", () => {
    setMain("true", "");
    expect(withdrawTimelineMs("main", "hourly")).toBe(TIMEFRAME_MS.hourly);
    setMain("true", "garbage");
    expect(withdrawTimelineMs("main", "hourly")).toBe(TIMEFRAME_MS.hourly);
    expect(hasCustomWithdrawTimeline("main")).toBe(false);
  });

  it("a SHORTER override wins when switched ON (8h on a daily cycle)", () => {
    setMain("true", "8h");
    expect(customWithdrawTimelineMs("main")).toBe(28_800_000);
    expect(hasCustomWithdrawTimeline("main")).toBe(true);
    expect(withdrawTimelineMs("main", "daily")).toBe(28_800_000); // < 24h default
  });

  it("a LONGER override wins too (3 days on a daily cycle — held longer, not just shorter)", () => {
    setMain("true", "3d");
    expect(withdrawTimelineMs("main", "daily")).toBe(259_200_000);
    expect(withdrawTimelineMs("main", "daily")).toBeGreaterThan(
      TIMEFRAME_MS.daily,
    );
    // and longer than even the longest timeframe default (weekly = 7d? no — 3d < 7d), so
    // verify against the cycle's own timeframe: weekly cycle + 10d hold also extends.
    setMain("true", "10d");
    expect(withdrawTimelineMs("main", "weekly")).toBe(864_000_000);
    expect(withdrawTimelineMs("main", "weekly")).toBeGreaterThan(
      TIMEFRAME_MS.weekly,
    );
  });

  it("clamps an absurdly long override to the 32-bit setTimeout ceiling", () => {
    // 100 days (8.64e9 ms) exceeds the ~2.147e9 setTimeout limit; without the clamp the
    // auto-close timer would overflow and fire instantly. It must resolve to the cap, not the raw value.
    setMain("true", "100d");
    expect(customWithdrawTimelineMs("main")).toBe(MAX_WITHDRAW_TIMELINE_MS);
    expect(withdrawTimelineMs("main", "hourly")).toBe(MAX_WITHDRAW_TIMELINE_MS);
    // A value just under the cap is untouched.
    setMain("true", "20d"); // 1.728e9 < cap
    expect(customWithdrawTimelineMs("main")).toBe(1_728_000_000);
  });

  it("the two loops are independent (one switch never affects the other)", () => {
    setMain(undefined, undefined);
    setAlt("true", "2h");
    expect(withdrawTimelineMs("alt", "daily")).toBe(7_200_000);
    expect(withdrawTimelineMs("main", "daily")).toBe(TIMEFRAME_MS.daily); // unaffected
    expect(hasCustomWithdrawTimeline("alt")).toBe(true);
    expect(hasCustomWithdrawTimeline("main")).toBe(false);
  });

  it("accepts an injected env (pure / testable without process.env)", () => {
    const env = {
      [WITHDRAW_TIMELINE_ENV.main.enabled]: "true",
      [WITHDRAW_TIMELINE_ENV.main.value]: "1m",
    } as unknown as NodeJS.ProcessEnv;
    expect(withdrawTimelineMs("main", "weekly", env)).toBe(60_000);
    expect(withdrawTimelineMs("alt", "weekly", env)).toBe(TIMEFRAME_MS.weekly);
  });
});

/**
 * Component test on a REAL TradingService (paper mode, CMC mocked): a switched-on alt-loop
 * withdraw timeline must size the opened altcoin position's auto-close (closeAt) off the
 * override — and prove BOTH directions: a SHORTER hold and a LONGER hold than the forecast
 * timeframe. Plus the per-loop overrides must surface on the service and in getStatus().
 */
describe("withdraw-timeline wiring (component)", () => {
  const SAVE_KEYS = [
    "ENABLE_LIVE_TRADING",
    "COINMARKETCAP_API_KEY",
    "ASTRAEUS_STATE_DIR",
    "RISK_MAX_TRADE_USD",
    "RISK_MAX_DAILY_VOLUME_USD",
    "RISK_MAX_TRADES_PER_DAY",
    "RISK_MIN_CONVICTION",
    "PAPER_START_CASH_USD",
    "TRACK1_TRENDING_WATCHLIST",
    "AUTONOMOUS_WITHDRAW_TIMELINE_ENABLED",
    "AUTONOMOUS_WITHDRAW_TIMELINE",
    "TRACK1_ALTCOIN_WITHDRAW_TIMELINE_ENABLED",
    "TRACK1_ALTCOIN_WITHDRAW_TIMELINE",
  ];
  const saved = Object.fromEntries(SAVE_KEYS.map((k) => [k, process.env[k]]));
  const spies: Array<{ mockRestore: () => void }> = [];

  function newService() {
    process.env.ENABLE_LIVE_TRADING = "false"; // force paper executor
    process.env.COINMARKETCAP_API_KEY ||= "test-key";
    process.env.ASTRAEUS_STATE_DIR = mkdtempSync(
      join(tmpdir(), "astraeus-withdraw-"),
    );
    process.env.RISK_MAX_TRADE_USD = "5";
    process.env.RISK_MAX_DAILY_VOLUME_USD = "100";
    process.env.RISK_MAX_TRADES_PER_DAY = "8";
    process.env.RISK_MIN_CONVICTION = "60";
    process.env.PAPER_START_CASH_USD = "50";
    delete process.env.TRACK1_TRENDING_WATCHLIST; // use the baked-in default watchlist
    return new TradingService(createMockRuntime());
  }

  const base = {
    ok: true,
    traded: false,
    timeframe: "hourly" as const,
    direction: "sideways" as const,
    confidence: 0.5,
    entryPrice: 3000,
  };

  function mockAltcoinFeed(svc: TradingService) {
    spies.push(
      spyOn(CmcDataProvider.prototype, "getTrending").mockResolvedValue([
        { symbol: "MYX", name: "MYX Finance" },
      ] as never),
    );
    spies.push(
      spyOn(svc, "researchToken").mockResolvedValue({
        bias: "bullish",
        confidence: 0.7,
        priceUsd: 0.1,
      }),
    );
  }

  function clearTimers(svc: TradingService) {
    const timers = (
      svc as never as { timers: Map<string, ReturnType<typeof setTimeout>> }
    ).timers;
    for (const h of timers.values()) clearTimeout(h);
  }

  function openPosition(svc: TradingService): { closeAt: number } {
    const trades = (
      svc as never as { forecastTrades: Map<string, { closeAt: number }> }
    ).forecastTrades;
    return [...trades.values()][0];
  }

  afterEach(() => {
    for (const s of spies.splice(0)) s.mockRestore();
    for (const k of SAVE_KEYS) restoreEnv(k, saved[k]);
  });

  it("SHORTER: alt position closes after the custom span, not the timeframe", async () => {
    // 8h override on a daily-context cycle (here driven as hourly) → closeAt ≈ now + 8h.
    process.env.TRACK1_ALTCOIN_WITHDRAW_TIMELINE_ENABLED = "true";
    process.env.TRACK1_ALTCOIN_WITHDRAW_TIMELINE = "8h";
    const svc = newService();
    mockAltcoinFeed(svc);

    const before = Date.now();
    const r = await svc.scanAndTradeAltcoin("daily", base);
    const after = Date.now();
    expect(r.traded).toBe(true);
    const pos = openPosition(svc);
    // 8h, NOT the 24h daily default.
    expect(pos.closeAt).toBeGreaterThanOrEqual(before + 28_800_000);
    expect(pos.closeAt).toBeLessThanOrEqual(after + 28_800_000);
    expect(pos.closeAt).toBeLessThan(before + TIMEFRAME_MS.daily);
    clearTimers(svc);
  });

  it("LONGER: alt position is held PAST the timeframe when the override is bigger", async () => {
    // 3-day override on a daily cycle (default 24h) → held three days, i.e. LONGER.
    process.env.TRACK1_ALTCOIN_WITHDRAW_TIMELINE_ENABLED = "true";
    process.env.TRACK1_ALTCOIN_WITHDRAW_TIMELINE = "3d";
    const svc = newService();
    mockAltcoinFeed(svc);

    const before = Date.now();
    const r = await svc.scanAndTradeAltcoin("daily", base);
    const after = Date.now();
    expect(r.traded).toBe(true);
    const pos = openPosition(svc);
    expect(pos.closeAt).toBeGreaterThanOrEqual(before + 259_200_000);
    expect(pos.closeAt).toBeLessThanOrEqual(after + 259_200_000);
    // Emphatically LONGER than the 24h timeframe default.
    expect(pos.closeAt).toBeGreaterThan(before + TIMEFRAME_MS.daily);
    clearTimers(svc);
  });

  it("switch OFF keeps the timeframe default even with a value set", async () => {
    process.env.TRACK1_ALTCOIN_WITHDRAW_TIMELINE_ENABLED = "false";
    process.env.TRACK1_ALTCOIN_WITHDRAW_TIMELINE = "8h";
    const svc = newService();
    mockAltcoinFeed(svc);

    const before = Date.now();
    const r = await svc.scanAndTradeAltcoin("hourly", base);
    expect(r.traded).toBe(true);
    const pos = openPosition(svc);
    // ~1h out (hourly default), NOT 8h — the value is inert while the switch is off.
    expect(pos.closeAt).toBeGreaterThanOrEqual(
      before + TIMEFRAME_MS.hourly - 5_000,
    );
    expect(pos.closeAt).toBeLessThan(before + 28_800_000);
    clearTimers(svc);
  });

  it("exposes both per-loop overrides on the service and in getStatus()", async () => {
    process.env.AUTONOMOUS_WITHDRAW_TIMELINE_ENABLED = "true";
    process.env.AUTONOMOUS_WITHDRAW_TIMELINE = "3d";
    process.env.TRACK1_ALTCOIN_WITHDRAW_TIMELINE_ENABLED = "true";
    process.env.TRACK1_ALTCOIN_WITHDRAW_TIMELINE = "8h";
    const svc = newService();
    expect(svc.withdrawTimelineMainMs).toBe(259_200_000);
    expect(svc.withdrawTimelineAltMs).toBe(28_800_000);

    const st = await svc.getStatus();
    expect(st.withdrawTimelineMainMs).toBe(259_200_000);
    expect(st.withdrawTimelineAltMs).toBe(28_800_000);
  });

  it("leaves the status fields undefined when the switches are off", async () => {
    process.env.AUTONOMOUS_WITHDRAW_TIMELINE_ENABLED = "false";
    process.env.AUTONOMOUS_WITHDRAW_TIMELINE = "3d"; // present but inert
    delete process.env.TRACK1_ALTCOIN_WITHDRAW_TIMELINE_ENABLED;
    const svc = newService();
    expect(svc.withdrawTimelineMainMs).toBeUndefined();
    expect(svc.withdrawTimelineAltMs).toBeUndefined();
    const st = await svc.getStatus();
    expect(st.withdrawTimelineMainMs).toBeUndefined();
    expect(st.withdrawTimelineAltMs).toBeUndefined();
  });
});
