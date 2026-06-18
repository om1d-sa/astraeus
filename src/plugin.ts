import { type Plugin } from "@elizaos/core";
import { forecastAction } from "./actions/forecast";
import { forecastAndTradeAction } from "./actions/forecastAndTrade";
import { marketForecastAction } from "./actions/marketForecast";
import { cmcSkillAction } from "./actions/cmcSkill";
import { autonomousModeAction } from "./actions/autonomousMode";
import { closeAllAction } from "./actions/closeAll";
import { diagnosticsAction } from "./actions/diagnostics";
import { agentIdentityAction } from "./actions/agentIdentity";
import { x402PayAction } from "./actions/x402Pay";
import { TradingService } from "./agent/service";

/**
 * Astraeus trading plugin.
 *
 * Holds the agent's custom actions and services for autonomous spot trading on
 * BNB Smart Chain. This starts empty — actions/services are added here as they
 * are built:
 *   - market-data actions backed by the CoinMarketCap AI Agent Hub
 *   - execution actions backed by the Trust Wallet Agent Kit (TWAK)
 *   - an autonomous trading loop with risk guardrails
 *
 * (CoinMarketCap and TWAK can also be wired in as MCP servers via character
 * settings; this plugin is for project-specific logic that lives in-repo.)
 */
export const tradingPlugin: Plugin = {
  name: "astraeus-trading",
  description:
    "Custom actions and services for autonomous spot trading on BNB Smart Chain",
  actions: [
    forecastAction,
    forecastAndTradeAction,
    marketForecastAction,
    cmcSkillAction,
    autonomousModeAction,
    closeAllAction,
    diagnosticsAction,
    agentIdentityAction,
    x402PayAction,
  ],
  providers: [],
  services: [TradingService],
  evaluators: [],
};

export default tradingPlugin;
