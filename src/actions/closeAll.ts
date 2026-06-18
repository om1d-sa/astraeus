import {
  type Action,
  type ActionResult,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
} from "@elizaos/core";
import { TradingService } from "../agent/service";

/**
 * CLOSE_ALL_POSITIONS — manual kill switch.
 *
 * Sells every open ETH position the agent is holding back to USDT immediately,
 * cancelling each position's pending auto-close timer. Works in paper and live
 * (TWAK) mode. The autonomous loop itself keeps running on its schedule.
 */
export const closeAllAction: Action = {
  name: "CLOSE_ALL_POSITIONS",
  similes: [
    "CLOSE_ALL",
    "SELL_ALL",
    "EXIT_ALL",
    "FLATTEN",
    "LIQUIDATE_ALL",
    "CLOSE_POSITIONS",
  ],
  description:
    'Immediately sell ALL open ETH positions back to USDT (close everything the agent bought). Use for "close all positions", "sell all", "exit everything", "flatten", "liquidate".',

  validate: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
  ): Promise<boolean> => {
    const t = (message.content?.text ?? "").toLowerCase();
    return (
      /\b(close|sell|exit|flatten|liquidate|dump|unwind)\b/.test(t) &&
      /\b(all|everything|positions?|trades?|eth|holdings?)\b/.test(t)
    );
  },

  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State | undefined,
    _options: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const svc = runtime.getService(
      TradingService.serviceType,
    ) as unknown as TradingService | null;
    if (!svc) {
      await callback?.({
        text: "Trading service is not available (plugin not loaded?).",
        error: true,
      });
      return { text: "no service", success: false };
    }

    try {
      const before = await svc.getStatus();
      if (before.openTrades.length === 0) {
        await callback?.({
          text: "No open positions to close.",
          actions: ["CLOSE_ALL_POSITIONS"],
        });
        return { text: "none", success: true, values: { closed: 0 } };
      }

      const r = await svc.closeAllPositions();
      const after = await svc.getStatus();
      const cash = after.portfolio
        ? `$${after.portfolio.cashUsd.toFixed(2)}`
        : "?";
      const text = `🧹 Closed ${r.closed} position${r.closed === 1 ? "" : "s"} (sold ETH → USDT). Cash now ${cash}.`;
      await callback?.({ text, actions: ["CLOSE_ALL_POSITIONS"] });
      return { text, success: true, values: { closed: r.closed } };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await callback?.({ text: `Close-all failed: ${msg}`, error: true });
      return {
        text: "error",
        success: false,
        error: error instanceof Error ? error : new Error(msg),
      };
    }
  },

  examples: [
    [
      { name: "{{name1}}", content: { text: "close all positions" } },
      {
        name: "Astraeus",
        content: {
          text: "🧹 Closed 2 positions (sold ETH → USDT). Cash now $15.01.",
          actions: ["CLOSE_ALL_POSITIONS"],
        },
      },
    ],
    [
      { name: "{{name1}}", content: { text: "sell all my ETH now" } },
      {
        name: "Astraeus",
        content: {
          text: "🧹 Closed 1 position (sold ETH → USDT). …",
          actions: ["CLOSE_ALL_POSITIONS"],
        },
      },
    ],
  ],
};

export default closeAllAction;
