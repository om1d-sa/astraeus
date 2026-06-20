import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { TwakExecutor, isTransientSwapError } from "../exec/twak";
import type { SwapRequest } from "../exec/types";

/**
 * Tests for the live-swap transient-retry logic (TwakExecutor.swap).
 * TWAK's price/quote upstream is intermittently flaky ("NETWORK_ERROR" / "unable to
 * fetch price") before any tx is sent — so we retry those, but NEVER a real on-chain
 * revert or an auth/funds failure. We override the private `run` with a scripted mock
 * (no CLI, no network, no money) to drive each path.
 */

const REQ: SwapRequest = {
  fromSymbol: "USDT",
  toSymbol: "ETH",
  amountUsd: 5,
  maxSlippageBps: 100,
};

type RunResult = { json: unknown; raw: string };

function execWith(responses: RunResult[]): {
  exec: TwakExecutor;
  calls: () => number;
} {
  const exec = new TwakExecutor({ chain: "bsc" });
  let calls = 0;
  (exec as unknown as { run: (args: string[]) => Promise<RunResult> }).run =
    async () => {
      const r = responses[Math.min(calls, responses.length - 1)];
      calls++;
      return r;
    };
  return { exec, calls: () => calls };
}

describe("isTransientSwapError", () => {
  it("flags transient upstream/price/network blips for retry", () => {
    expect(isTransientSwapError("Unable to fetch price for USDT on bsc")).toBe(
      true,
    );
    expect(isTransientSwapError("NETWORK_ERROR")).toBe(true);
    expect(isTransientSwapError("request timed out")).toBe(true);
    expect(isTransientSwapError("rate limit exceeded")).toBe(true);
  });

  it("does NOT retry real reverts, auth, or insufficient-funds", () => {
    expect(
      isTransientSwapError("execution reverted: claim tokens failed"),
    ).toBe(false);
    expect(isTransientSwapError("APPROVAL_SENT_SWAP_FAILED")).toBe(false);
    expect(isTransientSwapError("403 Forbidden — check your API key")).toBe(
      false,
    );
    expect(isTransientSwapError("insufficient balance")).toBe(false);
  });
});

describe("TwakExecutor.swap retry", () => {
  let savedRetries: string | undefined;
  let savedDelay: string | undefined;
  beforeEach(() => {
    savedRetries = process.env.TWAK_SWAP_RETRIES;
    savedDelay = process.env.TWAK_SWAP_RETRY_MS;
    process.env.TWAK_SWAP_RETRY_MS = "0"; // no real wait in tests
  });
  afterEach(() => {
    if (savedRetries === undefined) delete process.env.TWAK_SWAP_RETRIES;
    else process.env.TWAK_SWAP_RETRIES = savedRetries;
    if (savedDelay === undefined) delete process.env.TWAK_SWAP_RETRY_MS;
    else process.env.TWAK_SWAP_RETRY_MS = savedDelay;
  });

  const transient: RunResult = {
    json: {
      error: "unable to fetch price for USDT on bsc",
      errorCode: "NETWORK_ERROR",
    },
    raw: "",
  };

  it("retries transient blips and then succeeds", async () => {
    process.env.TWAK_SWAP_RETRIES = "10";
    const ok: RunResult = { json: { txHash: "0xabc" }, raw: "" };
    const { exec, calls } = execWith([transient, transient, ok]);
    const r = await exec.swap(REQ);
    expect(r.ok).toBe(true);
    expect(r.txHash).toBe("0xabc");
    expect(calls()).toBe(3); // two transient + one success
  });

  it("does NOT retry a real revert — returns on the first attempt", async () => {
    process.env.TWAK_SWAP_RETRIES = "10";
    const revert: RunResult = {
      json: {
        error: "execution reverted: claim tokens failed",
        errorCode: "TX_FAILED",
      },
      raw: "",
    };
    const { exec, calls } = execWith([revert]);
    const r = await exec.swap(REQ);
    expect(r.ok).toBe(false);
    expect(calls()).toBe(1); // no retry on a real revert
  });

  it("gives up after exactly TWAK_SWAP_RETRIES transient failures", async () => {
    process.env.TWAK_SWAP_RETRIES = "5";
    const { exec, calls } = execWith([transient]); // always transient
    const r = await exec.swap(REQ);
    expect(r.ok).toBe(false);
    expect(calls()).toBe(5);
  });
});
