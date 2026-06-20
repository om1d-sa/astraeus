import { describe, expect, it, beforeAll, spyOn } from "bun:test";
import { logger, type IAgentRuntime } from "@elizaos/core";
import { TradingService } from "../agent/service";

/**
 * Unit tests for the Track-1 qualifying round-trip (doQualifyingTrade) — the core of
 * the standalone 12h heartbeat. We construct a TradingService and override its private
 * executor/provider with mocks (no network, no real swaps, no API credits), then drive
 * the round-trip directly to lock in: buy→sell on success, and the failure paths that
 * make runQualifyCycle retry in 5 min.
 */

beforeAll(() => {
  spyOn(logger, "info");
  spyOn(logger, "warn");
  spyOn(logger, "error");
});

interface MockSwap {
  fromSymbol: string;
  toSymbol: string;
  amountUsd: number;
  maxSlippageBps: number;
}

// Build a TradingService with mocked executor + provider (private fields overridden).
function makeService(exec: unknown, prov: unknown): {
  svc: { doQualifyingTrade(): Promise<boolean> };
} {
  const runtime = {
    getService: () => null,
    character: { name: "Test" },
    agentId: "test",
  } as unknown as IAgentRuntime;
  const svc = new TradingService(runtime) as unknown as Record<string, unknown>;
  svc.executor = exec;
  svc.provider = prov;
  return { svc: svc as unknown as { doQualifyingTrade(): Promise<boolean> } };
}

const ethPrice = {
  getTokenSignals: async () => [{ symbol: "ETH", priceUsd: 3000 }],
};
const fundedPortfolio = async () => ({
  totalValueUsd: 100,
  cashUsd: 100,
  holdings: [],
});

describe("qualifying round-trip (doQualifyingTrade)", () => {
  it("buys ETH then immediately sells it back, returning true on success", async () => {
    const swaps: MockSwap[] = [];
    const exec = {
      mark: () => {},
      getPortfolio: fundedPortfolio,
      swap: async (r: MockSwap) => {
        swaps.push(r);
        return { ok: true, txHash: "0xabc" };
      },
    };
    const { svc } = makeService(exec, ethPrice);
    expect(await svc.doQualifyingTrade()).toBe(true);
    expect(swaps.length).toBe(2);
    expect([swaps[0].fromSymbol, swaps[0].toSymbol]).toEqual(["USDT", "ETH"]); // buy
    expect([swaps[1].fromSymbol, swaps[1].toSymbol]).toEqual(["ETH", "USDT"]); // sell back
  });

  it("returns false (→ heartbeat will retry in 5 min) when the buy fails (e.g. 403)", async () => {
    const exec = {
      mark: () => {},
      getPortfolio: fundedPortfolio,
      swap: async () => ({ ok: false, error: "403 Forbidden" }),
    };
    const { svc } = makeService(exec, ethPrice);
    expect(await svc.doQualifyingTrade()).toBe(false);
  });

  it("returns false when cash is below the trade size", async () => {
    const exec = {
      mark: () => {},
      getPortfolio: async () => ({ totalValueUsd: 1, cashUsd: 1, holdings: [] }),
      swap: async () => ({ ok: true, txHash: "0x" }),
    };
    const { svc } = makeService(exec, ethPrice);
    expect(await svc.doQualifyingTrade()).toBe(false);
  });

  it("returns false when no ETH price is available", async () => {
    const exec = {
      mark: () => {},
      getPortfolio: fundedPortfolio,
      swap: async () => ({ ok: true }),
    };
    const noPrice = { getTokenSignals: async () => [{ symbol: "ETH", priceUsd: 0 }] };
    const { svc } = makeService(exec, noPrice);
    expect(await svc.doQualifyingTrade()).toBe(false);
  });
});
