import { describe, expect, it, spyOn, beforeAll } from "bun:test";
import plugin from "../plugin";
import { TradingService } from "../agent/service";
import { logger } from "@elizaos/core";
import type { Action } from "@elizaos/core";
import {
  runCoreActionTests,
  createMockRuntime,
  createMockMessage,
  createMockState,
} from "./utils/core-test-utils";

/**
 * Component tests for the Astraeus trading plugin.
 *
 * Verifies that every feature (action) is wired into the plugin, has a valid
 * structure, and that each action's `validate()` routing fires on the messages it
 * is meant to handle (and defers on the messages it should NOT handle).
 */

beforeAll(() => {
  spyOn(logger, "info");
  spyOn(logger, "error");
  spyOn(logger, "warn");
});

// The complete set of features the agent exposes. Keep in sync with src/plugin.ts.
const EXPECTED_ACTIONS = [
  "OPTIONS_FORECAST",
  "FORECAST_AND_TRADE",
  "MARKET_FORECAST",
  "CMC_SKILL",
  "AUTONOMOUS_MODE",
  "CLOSE_ALL_POSITIONS",
  "TRADE_DIAGNOSTICS",
  "AGENT_DEBUG",
  "AGENT_IDENTITY",
  "X402_PAY",
  "TRENDING",
  "RESEARCH",
  "PORTFOLIO_ANALYSIS",
  "LIQUIDATION_ANALYSIS",
] as const;

const actions = plugin.actions ?? [];
const byName = (name: string): Action | undefined =>
  actions.find((a) => a.name === name);

describe("Plugin wiring", () => {
  it("has the expected metadata", () => {
    expect(plugin.name).toBe("astraeus-trading");
    expect(plugin.description).toBeTruthy();
  });

  it("registers the TradingService", () => {
    expect(plugin.services).toBeDefined();
    expect(plugin.services).toContain(TradingService);
    expect(TradingService.serviceType).toBe("astraeus-trading");
  });

  it("registers every expected feature action exactly once", () => {
    for (const name of EXPECTED_ACTIONS) {
      const matches = actions.filter((a) => a.name === name);
      expect(matches.length).toBe(1);
    }
  });

  it("has no actions beyond the expected feature set", () => {
    const names = actions.map((a) => a.name).sort();
    expect(names).toEqual([...EXPECTED_ACTIONS].sort());
  });

  it("passes the core ElizaOS action-structure checks", () => {
    const results = runCoreActionTests(actions);
    expect(results.formattedNames).toBeDefined();
    expect(results.formattedActions).toBeDefined();
    expect(results.composedExamples).toBeDefined();
  });
});

describe("Action structure", () => {
  for (const name of EXPECTED_ACTIONS) {
    it(`${name} has a complete, well-formed shape`, () => {
      const action = byName(name);
      expect(action).toBeDefined();
      if (!action) return;
      expect(action.name).toBe(name);
      expect(typeof action.description).toBe("string");
      expect(action.description.length).toBeGreaterThan(0);
      expect(Array.isArray(action.similes)).toBe(true);
      expect(Array.isArray(action.examples)).toBe(true);
      expect(action.examples?.length ?? 0).toBeGreaterThan(0);
      expect(typeof action.validate).toBe("function");
      expect(typeof action.handler).toBe("function");
    });
  }
});

describe("Action routing (validate)", () => {
  const runtime = createMockRuntime();
  const state = createMockState();

  // A representative message that SHOULD route to each action, and (optionally)
  // one that should NOT — to lock in the key inter-action boundaries.
  const cases: Array<{
    action: (typeof EXPECTED_ACTIONS)[number];
    accept: string[];
    reject?: string[];
  }> = [
    {
      action: "OPTIONS_FORECAST",
      accept: ["what's your forecast for ETH daily?", "BTC price outlook weekly"],
      // "...and trade" defers to FORECAST_AND_TRADE; no asset = no forecast.
      reject: ["forecast and trade ETH daily", "what's the forecast?"],
    },
    {
      action: "FORECAST_AND_TRADE",
      accept: ["forecast and trade ETH daily", "forecast ETH then buy"],
      reject: ["what's your forecast for ETH?"],
    },
    {
      action: "MARKET_FORECAST",
      accept: ["overall market direction daily", "market sentiment right now"],
      // "overview"/"skill" belongs to CMC_SKILL.
      reject: ["run the market overview skill", "forecast ETH daily"],
    },
    {
      action: "CMC_SKILL",
      accept: ["run the daily_market_overview skill", "execute the market overview skill"],
    },
    {
      action: "AUTONOMOUS_MODE",
      accept: ["start auto trading", "agent status", "show pnl"],
      // close/sell defers to CLOSE_ALL_POSITIONS.
      reject: ["close all positions"],
    },
    {
      action: "CLOSE_ALL_POSITIONS",
      accept: ["close all positions", "sell everything", "flatten all eth"],
    },
    {
      action: "TRADE_DIAGNOSTICS",
      accept: ["run diagnostics", "health check", "is everything working", "debug trade", "why no trade"],
      // Full-agent / skill-bundle debug defers to AGENT_DEBUG.
      reject: ["debug skill bundles", "agent debug report"],
    },
    {
      action: "AGENT_DEBUG",
      accept: [
        "debug skill bundles",
        "agent debug report",
        "debug everything",
        "probe the skills",
        "debug research skills",
      ],
      // Plain trade health stays with TRADE_DIAGNOSTICS; non-debug messages don't route here.
      reject: ["run diagnostics", "health check", "debug trade"],
    },
    {
      action: "AGENT_IDENTITY",
      accept: ["register agent identity", "mint erc-8004 identity"],
    },
    {
      action: "X402_PAY",
      accept: ["x402 quote https://example.com/data", "pay-per-request https://api.test/x"],
    },
    {
      action: "TRENDING",
      accept: ["what's trending in crypto", "show me the top movers"],
    },
    {
      action: "RESEARCH",
      accept: ["research BTC fundamentals", "due diligence on ETH"],
    },
    {
      action: "PORTFOLIO_ANALYSIS",
      accept: ["portfolio analysis: 40% BTC, 30% ETH, 30% USDT", "review my holdings risk"],
    },
    {
      action: "LIQUIDATION_ANALYSIS",
      accept: ["liquidation cascade analysis", "short squeeze risk after this dump"],
    },
  ];

  for (const { action, accept, reject } of cases) {
    const a = byName(action);
    it(`${action} accepts its own messages`, async () => {
      expect(a).toBeDefined();
      if (!a) return;
      for (const text of accept) {
        const ok = await a.validate(runtime, createMockMessage(text), state);
        expect(ok).toBe(true);
      }
    });

    if (reject) {
      it(`${action} defers on messages it should not handle`, async () => {
        expect(a).toBeDefined();
        if (!a) return;
        for (const text of reject) {
          const ok = await a.validate(runtime, createMockMessage(text), state);
          expect(ok).toBe(false);
        }
      });
    }
  }
});
