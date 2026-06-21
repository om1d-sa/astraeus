import { type IAgentRuntime, type Action, logger } from "@elizaos/core";

/**
 * E2E test suite for Astraeus — runs inside a real ElizaOS runtime.
 *
 * Unlike the component tests (bun:test, isolated), these execute against a live
 * runtime with the plugin loaded, so they verify that every feature is actually
 * registered and reachable end-to-end. This suite is attached to the plugin via
 * `tests` (see src/plugin.ts) and executed by `elizaos test e2e`.
 */

interface TestCase {
  name: string;
  fn: (runtime: IAgentRuntime) => Promise<void>;
}

interface TestSuite {
  name: string;
  tests: TestCase[];
}

/** Every feature the agent exposes — kept in sync with src/plugin.ts. */
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
];

export const AstraeusE2ETestSuite: TestSuite = {
  name: "Astraeus E2E Tests",
  tests: [
    {
      name: "runtime_and_character_initialize",
      fn: async (runtime: IAgentRuntime) => {
        if (!runtime) throw new Error("Runtime is not initialized");
        if (!runtime.agentId) throw new Error("Agent ID is not set");
        if (!runtime.character) throw new Error("Character is not loaded");
        if (runtime.character.name !== "Astraeus") {
          throw new Error(
            `Expected character "Astraeus", got "${runtime.character.name}"`,
          );
        }
        logger.info(`✓ Astraeus initialized (agent ${runtime.agentId})`);
      },
    },

    {
      name: "all_feature_actions_are_registered",
      fn: async (runtime: IAgentRuntime) => {
        const registered = new Set(
          (runtime.actions ?? []).map((a: Action) => a.name),
        );
        const missing = EXPECTED_ACTIONS.filter((n) => !registered.has(n));
        if (missing.length > 0) {
          throw new Error(`Missing registered actions: ${missing.join(", ")}`);
        }
        logger.info(
          `✓ All ${EXPECTED_ACTIONS.length} feature actions registered in the runtime`,
        );
      },
    },

    {
      name: "every_action_has_validate_and_handler",
      fn: async (runtime: IAgentRuntime) => {
        for (const name of EXPECTED_ACTIONS) {
          const action = (runtime.actions ?? []).find(
            (a: Action) => a.name === name,
          );
          if (!action) throw new Error(`Action ${name} not found`);
          if (typeof action.validate !== "function") {
            throw new Error(`Action ${name} is missing validate()`);
          }
          if (typeof action.handler !== "function") {
            throw new Error(`Action ${name} is missing handler()`);
          }
        }
        logger.info("✓ Every feature action has validate() and handler()");
      },
    },

    {
      name: "validate_routes_representative_messages",
      fn: async (runtime: IAgentRuntime) => {
        const find = (name: string) =>
          (runtime.actions ?? []).find((a: Action) => a.name === name);
        const mkMsg = (text: string) =>
          ({ content: { text, source: "test" } }) as never;
        const state = { values: {}, data: {}, text: "" } as never;

        // (action, message that must route to it)
        const checks: Array<[string, string]> = [
          ["OPTIONS_FORECAST", "what's your forecast for ETH daily?"],
          ["FORECAST_AND_TRADE", "forecast and trade ETH daily"],
          ["MARKET_FORECAST", "overall market direction daily"],
          ["CMC_SKILL", "run the daily_market_overview skill"],
          ["CLOSE_ALL_POSITIONS", "close all positions"],
          ["TRADE_DIAGNOSTICS", "run diagnostics"],
          ["AGENT_DEBUG", "debug skill bundles"],
          ["TRENDING", "what's trending in crypto"],
          ["RESEARCH", "research BTC fundamentals"],
          ["PORTFOLIO_ANALYSIS", "portfolio analysis: 40% BTC, 60% ETH"],
          ["LIQUIDATION_ANALYSIS", "liquidation cascade analysis"],
        ];

        for (const [name, text] of checks) {
          const action = find(name);
          if (!action) throw new Error(`Action ${name} not found`);
          const ok = await action.validate(runtime, mkMsg(text), state);
          if (ok !== true) {
            throw new Error(
              `${name}.validate did not accept its message: "${text}"`,
            );
          }
        }
        logger.info("✓ Action routing validated end-to-end");
      },
    },

    {
      name: "trading_service_is_available",
      fn: async (runtime: IAgentRuntime) => {
        const service = runtime.getService("astraeus-trading");
        if (!service) {
          // Service init needs COINMARKETCAP_API_KEY; in a bare test env it may be
          // skipped. Don't hard-fail the suite on an environment limitation.
          logger.info(
            "⚠ astraeus-trading service not registered (likely missing COINMARKETCAP_API_KEY in test env)",
          );
          return;
        }
        logger.info("✓ astraeus-trading service is available");
      },
    },

    {
      name: "take_profit_config_is_exposed",
      fn: async (runtime: IAgentRuntime) => {
        const service = runtime.getService("astraeus-trading") as unknown as {
          takeProfitPct?: number;
          takeProfitEnabled?: boolean;
        } | null;
        if (!service) {
          logger.info(
            "⚠ service not registered (missing COINMARKETCAP_API_KEY?) — skipping take-profit check",
          );
          return;
        }
        if (typeof service.takeProfitPct !== "number") {
          throw new Error(
            "take-profit config (takeProfitPct) not exposed on the service",
          );
        }
        if (typeof service.takeProfitEnabled !== "boolean") {
          throw new Error(
            "take-profit toggle (takeProfitEnabled) not exposed on the service",
          );
        }
        logger.info(
          `✓ take-profit config exposed: ${service.takeProfitEnabled ? `+${service.takeProfitPct}%` : "off"}`,
        );
      },
    },

    {
      name: "positions_report_is_well_formed",
      fn: async (runtime: IAgentRuntime) => {
        const service = runtime.getService("astraeus-trading") as unknown as {
          getPositions?: () => Promise<{
            positions: unknown[];
            totalPnlUsd: number;
            totalValueUsd: number;
            anyPriced: boolean;
          }>;
        } | null;
        if (!service?.getPositions) {
          logger.info(
            "⚠ service/getPositions not available (missing COINMARKETCAP_API_KEY?) — skipping positions check",
          );
          return;
        }
        // With no open positions this does no network call and must be deterministic.
        const rep = await service.getPositions();
        if (!Array.isArray(rep.positions)) {
          throw new Error("getPositions() did not return a positions array");
        }
        if (
          typeof rep.totalPnlUsd !== "number" ||
          typeof rep.totalValueUsd !== "number" ||
          typeof rep.anyPriced !== "boolean"
        ) {
          throw new Error("getPositions() report is missing aggregate PnL fields");
        }
        logger.info(
          `✓ positions report well-formed (${rep.positions.length} open, PnL $${rep.totalPnlUsd.toFixed(2)})`,
        );
      },
    },

    {
      name: "agent_status_routing_and_render",
      fn: async (runtime: IAgentRuntime) => {
        const action = (runtime.actions ?? []).find(
          (a: Action) => a.name === "AUTONOMOUS_MODE",
        );
        if (!action) throw new Error("AUTONOMOUS_MODE action not found");
        const mkMsg = (text: string) =>
          ({ content: { text, source: "test" } }) as never;
        const state = { values: {}, data: {}, text: "" } as never;
        // "agent status" and "show pnl" both belong to AUTONOMOUS_MODE…
        for (const text of ["agent status", "show pnl", "what am I holding"]) {
          if ((await action.validate(runtime, mkMsg(text), state)) !== true) {
            throw new Error(`AUTONOMOUS_MODE.validate rejected "${text}"`);
          }
        }
        // …but "close all positions" must defer to CLOSE_ALL_POSITIONS.
        if (
          (await action.validate(
            runtime,
            mkMsg("close all positions"),
            state,
          )) !== false
        ) {
          throw new Error(
            'AUTONOMOUS_MODE.validate should defer "close all positions"',
          );
        }
        logger.info("✓ agent-status routing intact (PnL/positions view)");
      },
    },

    {
      name: "system_prompt_documents_core_routing",
      fn: async (runtime: IAgentRuntime) => {
        const system = runtime.character?.system ?? "";
        const mustMention = [
          "OPTIONS_FORECAST",
          "MARKET_FORECAST",
          "PORTFOLIO_ANALYSIS",
          "LIQUIDATION_ANALYSIS",
        ];
        const missing = mustMention.filter((m) => !system.includes(m));
        if (missing.length > 0) {
          throw new Error(
            `System prompt does not document routing for: ${missing.join(", ")}`,
          );
        }
        logger.info("✓ System prompt documents core action routing");
      },
    },
  ],
};

export default AstraeusE2ETestSuite;
