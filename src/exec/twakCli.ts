/**
 * Shared Trust Wallet Agent Kit (TWAK) CLI helper.
 *
 * One place to shell out to the `twak` binary and parse its JSON. Used by the
 * executor (trading), the ERC-8004 identity layer, and the x402 payment layer —
 * all self-custody: TWAK signs with the key in the OS keychain, so the wallet
 * password / private key never pass through this process.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pExecFile = promisify(execFile);

export interface RunTwakOptions {
  /** twak binary name/path (default 'twak', overridable via TWAK_BIN). */
  bin?: string;
  /** Per-command timeout in ms (default 120000). */
  timeoutMs?: number;
}

export interface TwakResult {
  json: unknown;
  raw: string;
  /**
   * Captured stderr. twak prints progress/status lines here — NOT stdout — including
   * the x402 payment confirmation ("payment authorization signed"). stdout carries
   * only the JSON payload, so callers that need to know whether a payment happened
   * must read this, not `raw`.
   */
  stderr: string;
}

/** Run a `twak` command; returns loose-parsed JSON + raw stdout + stderr (even on error exit). */
export async function runTwak(
  args: string[],
  opts: RunTwakOptions = {},
): Promise<TwakResult> {
  const bin = opts.bin ?? process.env.TWAK_BIN ?? "twak";
  const timeout = opts.timeoutMs ?? 120_000;
  let raw = "";
  let errOut = "";
  try {
    const { stdout, stderr } = await pExecFile(bin, args, {
      timeout,
      // Windows installs the global bin as twak.cmd; shell resolves it via PATH.
      // All args are controlled (fixed flags, symbols, numbers, validated URLs) — no injection surface.
      shell: true,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    });
    raw = stdout ?? "";
    errOut = stderr ?? "";
  } catch (e) {
    // twak exits non-zero on API/network errors but still prints JSON to stdout.
    const err = e as { stdout?: string; stderr?: string; message?: string };
    raw = err?.stdout ?? "";
    errOut = err?.stderr ?? "";
    if (!raw) {
      throw new Error(
        `twak ${args[0]} failed: ${err?.stderr || err?.message || String(e)}`,
      );
    }
  }
  return { json: parseLooseJson(raw), raw, stderr: errOut };
}

export function parseLooseJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    // twak sometimes prints a human-readable line before the JSON body.
    const objStart = text.indexOf("{");
    const arrStart = text.indexOf("[");
    const start =
      objStart < 0
        ? arrStart
        : arrStart < 0
          ? objStart
          : Math.min(objStart, arrStart);
    if (start < 0) return null;
    const close = text[start] === "{" ? "}" : "]";
    const end = text.lastIndexOf(close);
    if (end <= start) return null;
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

export function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

export function firstArray(
  obj: Record<string, unknown>,
  keys: string[],
): unknown[] | undefined {
  for (const k of keys) {
    if (Array.isArray(obj[k])) return obj[k] as unknown[];
  }
  return undefined;
}

export function pickNumber(
  obj: Record<string, unknown>,
  keys: string[],
): number | undefined {
  for (const k of keys) {
    const v = obj[k];
    const n = typeof v === "string" ? Number(v) : v;
    if (typeof n === "number" && Number.isFinite(n)) return n;
  }
  return undefined;
}

export function pickString(
  obj: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

export function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
