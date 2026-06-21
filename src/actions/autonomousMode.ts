import {
  type Action,
  type ActionResult,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
} from "@elizaos/core";
import {
  TradingService,
  type TradingStatus,
  type PositionsReport,
} from "../agent/service";

type Intent = "start" | "stop" | "status";

function parseIntent(text: string): Intent {
  const t = text.toLowerCase();
  if (/\b(stop|halt|pause|disable|kill|off|cease)\b/.test(t)) return "stop";
  if (/\b(start|enable|begin|resume|activate|launch|turn on|go live)\b/.test(t))
    return "start";
  return "status";
}

const fmtUsd = (n: number): string =>
  `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`;
const fmtPct = (n: number): string => `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
const pnlDot = (pnl: number): string =>
  pnl > 0 ? "🟢" : pnl < 0 ? "🔴" : "⚪";
/** Compact "closes in 3h 12m" / "12m" / "now". */
const closesIn = (closeAt: number): string => {
  const ms = closeAt - Date.now();
  if (ms <= 0) return "now";
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
};

function formatStatus(st: TradingStatus, pos: PositionsReport): string {
  const lines = [
    `Autonomous trading: ${st.running ? "🟢 RUNNING" : "⚪ stopped"} (${st.mode} mode)`,
    `Strategy: forecast-driven ETH spot · $${st.tradeSizeUsd}/trade · ${st.baseTimeframe} every ${Math.round(st.intervalMs / 3_600_000)}h${st.takeProfitEnabled ? ` · take-profit +${st.takeProfitPct}%` : ""}`,
  ];
  if (st.running && st.nextTimeframe && st.nextRunAt) {
    const retry = st.retryStep > 0 ? ` · retry #${st.retryStep}` : "";
    lines.push(
      `Next: ${st.nextTimeframe} forecast @ ${new Date(st.nextRunAt).toUTCString()}${retry}`,
    );
  }
  if (st.portfolio) {
    lines.push(
      `Equity: $${st.portfolio.totalValueUsd.toFixed(2)}  |  cash $${st.portfolio.cashUsd.toFixed(2)}`,
    );
    if (st.portfolio.holdings.length) {
      lines.push(
        `Holdings: ${st.portfolio.holdings.map((h) => `${h.symbol} $${h.valueUsd.toFixed(2)}`).join(", ")}`,
      );
    }
  }
  if (pos.positions.length) {
    lines.push(`Open positions (${pos.positions.length}):`);
    for (const p of pos.positions) {
      lines.push(
        `  ${pnlDot(p.pnlUsd)} ${p.asset} ${fmtUsd(p.sizeUsd)} @ $${p.entryPrice.toFixed(2)} → $${p.currentPrice.toFixed(2)}${p.priced ? "" : "*"} · PnL ${fmtUsd(p.pnlUsd)} (${fmtPct(p.pnlPct)}) · ${p.timeframe}, closes in ${closesIn(p.closeAt)}`,
      );
    }
    lines.push(
      `  ${pnlDot(pos.totalPnlUsd)} Unrealized PnL: ${fmtUsd(pos.totalPnlUsd)} (${fmtPct(pos.totalPnlPct)}) on ${fmtUsd(pos.totalCostUsd)} cost`,
    );
    if (!pos.anyPriced)
      lines.push("  * live price unavailable — PnL shown at entry (flat)");
  } else {
    lines.push("Open positions: none");
  }
  if (st.lastResult) {
    const r = st.lastResult;
    lines.push(
      `Last forecast (${r.timeframe}): ${(r.direction ?? "?").toUpperCase()} — ${r.traded ? "traded" : (r.reason ?? "no trade")}`,
    );
  }
  return lines.join("\n");
}

/**
 * AUTONOMOUS_MODE — start / stop / status for the in-agent trading loop.
 */
export const autonomousModeAction: Action = {
  name: "AUTONOMOUS_MODE",
  similes: [
    "START_AUTO",
    "STOP_AUTO",
    "AUTO_TRADE",
    "AGENT_STATUS",
    "TRADING_STATUS",
    "START_TRADING",
    "STOP_TRADING",
  ],
  description:
    'Start, stop, or check the autonomous trading loop (paper mode). The status view lists every OPEN position with live mark-to-market PnL (entry vs current price, unrealized $ and %). Use for "start auto", "stop auto", "agent status", "positions", "show pnl", "what am I holding", "show portfolio".',

  validate: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
  ): Promise<boolean> => {
    const t = (message.content?.text ?? "").toLowerCase();
    // Defer to CLOSE_ALL_POSITIONS when the user wants to close/sell/exit holdings.
    if (/\b(close|sell|exit|flatten|liquidate)\b/.test(t)) return false;
    return /\b(auto|autonomous|trading (loop|status|mode)|agent status|start trad|stop trad|paper trad|pnl|p&l|unrealized|holdings?|holding|portfolio|positions?)\b/.test(
      t,
    );
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined,
    _options: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const intent = parseIntent(message.content?.text ?? "");
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
      if (intent === "start") {
        const r = svc.startLoop();
        const modeLabel = svc.mode === "live" ? "LIVE on BSC" : "paper mode";
        const text = r.ok
          ? `▶️ Autonomous trading STARTED (${modeLabel}) — forecast-driven ETH (${svc.autoTimeframe}), every ${Math.round(svc.intervalMs / 3_600_000)}h ($${svc.tradeSizeUsd}/trade); retries on shorter timeframes until a trade lands.`
          : `Could not start: ${r.reason}.`;
        await callback?.({ text, actions: ["AUTONOMOUS_MODE"] });
        return { text, success: r.ok, values: { running: svc.running } };
      }
      if (intent === "stop") {
        const stopped = svc.stopLoop();
        const text = stopped
          ? "⏹️ Autonomous trading STOPPED."
          : "Autonomous trading was not running.";
        await callback?.({ text, actions: ["AUTONOMOUS_MODE"] });
        return { text, success: true, values: { running: svc.running } };
      }
      const [st, pos] = await Promise.all([
        svc.getStatus(),
        svc.getPositions(),
      ]);
      await callback?.({
        text: formatStatus(st, pos),
        actions: ["AUTONOMOUS_MODE"],
      });
      return {
        text: "status",
        success: true,
        values: { openPositions: pos.positions.length, unrealizedPnlUsd: pos.totalPnlUsd },
        data: { status: st, positions: pos },
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await callback?.({ text: `Autonomous mode error: ${msg}`, error: true });
      return {
        text: "error",
        success: false,
        error: error instanceof Error ? error : new Error(msg),
      };
    }
  },

  examples: [
    [
      { name: "{{name1}}", content: { text: "start auto trading" } },
      {
        name: "Astraeus",
        content: {
          text: "▶️ Autonomous trading STARTED (paper mode) …",
          actions: ["AUTONOMOUS_MODE"],
        },
      },
    ],
    [
      { name: "{{name1}}", content: { text: "agent status" } },
      {
        name: "Astraeus",
        content: {
          text: "Autonomous trading: 🟢 RUNNING …\nOpen positions (1):\n  🟢 ETH $5.00 @ $3000.00 → $3300.00 · PnL +$0.50 (+10.00%) · daily, closes in 18h 4m\n  🟢 Unrealized PnL: +$0.50 (+10.00%) on $5.00 cost",
          actions: ["AUTONOMOUS_MODE"],
        },
      },
    ],
    [
      { name: "{{name1}}", content: { text: "what am I holding right now?" } },
      {
        name: "Astraeus",
        content: {
          text: "Autonomous trading: ⚪ stopped …\nOpen positions: none",
          actions: ["AUTONOMOUS_MODE"],
        },
      },
    ],
  ],
};

export default autonomousModeAction;
