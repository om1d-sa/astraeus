/**
 * Custom WITHDRAW position timeline (the "withdraw timeline" feature).
 *
 * A forecast-driven position normally auto-closes ("withdraws") after its forecast
 * timeframe — hourly→1h, 4h→4h, daily→24h, weekly→7d (see {@link TIMEFRAME_MS}). This
 * module lets the operator OVERRIDE that hold duration per loop, decoupled from the
 * forecast timeframe, via a per-loop ON/OFF switch plus a duration value:
 *
 *   - MAIN loop (ETH)       → AUTONOMOUS_WITHDRAW_TIMELINE_ENABLED + AUTONOMOUS_WITHDRAW_TIMELINE
 *   - ALT  loop (altcoins)  → TRACK1_ALTCOIN_WITHDRAW_TIMELINE_ENABLED + TRACK1_ALTCOIN_WITHDRAW_TIMELINE
 *
 * The override can be SHORTER or LONGER than the forecast timeframe: e.g. with a daily cycle
 * (24h default) a value of "3d" holds the position three days, "8h" holds it eight hours. The
 * value accepts human units — `s`/`m`/`h`/`d`/`w` (e.g. "3d", "8h", "30m", "1.5h") — or a bare
 * number of milliseconds. When the switch is OFF (default), or the value is blank/invalid, the
 * loop falls back to the timeframe default, so the feature is purely additive.
 *
 * This is the PURE core — env readers + parsing + the resolution rule, no network/state — so
 * the TradingService can size every position's close time off it and it stays unit-testable.
 */
import type { ForecastTimeframe } from "../options-forecast";

/** How long a forecast-driven position is held before auto-close, by forecast timeframe. */
export const TIMEFRAME_MS: Record<ForecastTimeframe, number> = {
  hourly: 3_600_000, // 1h
  fourHourly: 14_400_000, // 4h
  daily: 86_400_000, // 24h
  weekly: 604_800_000, // 7d
};

/** Which trading loop a position belongs to — selects which pair of env vars to read. */
export type WithdrawLoop = "main" | "alt";

/** The env vars backing each loop's custom withdraw timeline (the ON/OFF switch + the value). */
export const WITHDRAW_TIMELINE_ENV: Record<
  WithdrawLoop,
  { enabled: string; value: string }
> = {
  main: {
    enabled: "AUTONOMOUS_WITHDRAW_TIMELINE_ENABLED",
    value: "AUTONOMOUS_WITHDRAW_TIMELINE",
  },
  alt: {
    enabled: "TRACK1_ALTCOIN_WITHDRAW_TIMELINE_ENABLED",
    value: "TRACK1_ALTCOIN_WITHDRAW_TIMELINE",
  },
};

/**
 * Hard cap on a resolved withdraw timeline (ms). Node/Bun `setTimeout` stores its delay in a
 * signed 32-bit int: a delay beyond this OVERFLOWS and fires after ~1ms (TimeoutOverflowWarning),
 * which would slam a long-hold position closed the instant it opens. ≈24.8 days — far past any
 * sane forecast hold — so we clamp here to keep the auto-close timer correct. (The timeframe
 * defaults, ≤ 7d weekly, are already well under this.)
 */
export const MAX_WITHDRAW_TIMELINE_MS = 2_147_483_647;

/** Milliseconds per supported duration suffix. A bare number is taken as milliseconds. */
const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/**
 * Parse a duration into milliseconds: a positive number with an optional unit suffix —
 * "3d", "8h", "30m", "45s", "1.5h", "250ms", or a bare "1800000" (= ms). Returns `undefined`
 * for blank / non-positive / unparseable input. Pure, so it's directly unit-testable.
 */
export function parseDurationMs(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const s = raw.trim().toLowerCase();
  if (s === "") return undefined;
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)?$/.exec(s);
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const mult = m[2] ? UNIT_MS[m[2]] : 1; // bare number ⇒ milliseconds
  const ms = Math.trunc(n * mult);
  return ms > 0 ? ms : undefined;
}

/** Whether a loop's custom withdraw timeline is switched ON (only the literal "true" enables it). */
export function withdrawTimelineEnabled(
  loop: WithdrawLoop,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    (env[WITHDRAW_TIMELINE_ENV[loop].enabled] ?? "").trim().toLowerCase() ===
    "true"
  );
}

/**
 * The EFFECTIVE custom withdraw-timeline override (ms) for a loop: defined only when the
 * loop's switch is ON *and* its value parses to a positive duration — otherwise `undefined`
 * (so the caller falls back to the timeframe default). A value alone, with the switch off,
 * does nothing; the switch is what activates it.
 */
export function customWithdrawTimelineMs(
  loop: WithdrawLoop,
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  if (!withdrawTimelineEnabled(loop, env)) return undefined;
  const ms = parseDurationMs(env[WITHDRAW_TIMELINE_ENV[loop].value]);
  // Clamp so a huge value can't overflow the 32-bit setTimeout that arms the auto-close.
  return ms === undefined ? undefined : Math.min(ms, MAX_WITHDRAW_TIMELINE_MS);
}

/** True when a loop has its custom withdraw timeline switched ON with a valid duration. */
export function hasCustomWithdrawTimeline(
  loop: WithdrawLoop,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return customWithdrawTimelineMs(loop, env) !== undefined;
}

/**
 * Resolve how long a loop holds a position before auto-close ("withdraw"), in ms: the loop's
 * custom override when switched ON with a valid duration (which may be SHORTER or LONGER than
 * the forecast timeframe), otherwise the timeframe default. This is the single value the
 * TradingService uses for BOTH the position's `closeAt` and its auto-close timer, so the two
 * can never disagree.
 */
export function withdrawTimelineMs(
  loop: WithdrawLoop,
  timeframe: ForecastTimeframe,
  env: NodeJS.ProcessEnv = process.env,
): number {
  return customWithdrawTimelineMs(loop, env) ?? TIMEFRAME_MS[timeframe];
}
