/**
 * Format an epoch-ms timestamp as an absolute UTC time with a 12-hour AM/PM clock and
 * seconds, e.g. "Sun, Jun 22, 2026, 11:00:00 AM UTC". Used for every user-facing
 * schedule/timeline line so times are unambiguous regardless of the viewer's local zone.
 */
export const fmtUtc = (ms: number): string =>
  `${new Date(ms).toLocaleString("en-US", {
    timeZone: "UTC",
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  })} UTC`;
