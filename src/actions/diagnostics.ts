import {
  type Action,
  type ActionResult,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
} from "@elizaos/core";
import { TradingService, type DiagCheck } from "../agent/service";

const ICON: Record<DiagCheck["status"], string> = {
  pass: "✅",
  fail: "❌",
  warn: "⚠️",
  info: "•",
};

/**
 * TRADE_DIAGNOSTICS — one-shot readiness/health check of the trading system.
 *
 * Reports pass/fail for config, market data, the forecast engine, execution
 * (paper or TWAK), and current state. Runs live probes, so it surfaces real
 * issues (a missing key, the TWAK swap 403, a dead data source) immediately.
 */
export const diagnosticsAction: Action = {
  name: "TRADE_DIAGNOSTICS",
  similes: [
    "DIAGNOSTICS",
    "HEALTH_CHECK",
    "SELF_TEST",
    "SYSTEM_CHECK",
    "TRADING_HEALTH",
    "READINESS_CHECK",
  ],
  description:
    'Run a readiness/health check of the trading system (config, market data, forecast engine, execution, state) and report pass/fail. Use for "diagnostics", "run diagnostics", "health check", "self test", "is everything working".',

  validate: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
  ): Promise<boolean> => {
    const t = (message.content?.text ?? "").toLowerCase();
    // Explicit trade-health / generic health-check phrasings always route here.
    if (
      /\b(trade\s+diagnostics|debug\s+trade|why\s+no\s+trade|health\s*check|self[\s-]*test|system\s*check|readiness|is everything (ok|working|wired))\b/.test(
        t,
      )
    )
      return true;
    // A bare "diagnostics" IS the trade health-check — UNLESS a skill-bundle feature is
    // named ("crypto research diagnostics", "liquidation analysis diagnostics", …), which
    // AGENT_DEBUG live-probes instead. Plain "diagnostics" / "run diagnostics" stay here.
    if (/\bdiagnostics?\b/.test(t))
      return !/\b(skill|bundle|market|research|trend\w*|portfolio|liquidation|cascade|squeeze)\b/.test(
        t,
      );
    return false;
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
      // NO intermediate "running…" callback. ElizaOS buffers every action callback() and
      // flushes them all at the END with the SAME responseId (processActions →
      // storageCallback), so a progress note never shows live AND it claims message-id=R
      // first — the final report then re-uses id=R and the GUI dedups it, leaving the result
      // invisible until a manual Ctrl+R. One final callback (below) broadcasts as a fresh
      // message that renders live; the "thinking" indicator covers the ~10-20s probe.
      const checks = await svc.runDiagnostics();

      const passed = checks.filter((c) => c.status === "pass").length;
      const failed = checks.filter((c) => c.status === "fail").length;
      const warned = checks.filter((c) => c.status === "warn").length;
      const header =
        failed === 0
          ? `🩺 Trade diagnostics — ${warned === 0 ? "all systems go" : "ready, with warnings"} (${passed} passed${warned ? `, ${warned} warning(s)` : ""})`
          : `🩺 Trade diagnostics — ${failed} issue(s) found (${passed} passed, ${failed} failed)`;
      const body = checks
        .map((c) => `${ICON[c.status]} ${c.name}: ${c.detail}`)
        .join("\n");
      const text = `${header}\n${body}`;

      await callback?.({ text, actions: ["TRADE_DIAGNOSTICS"] });
      return {
        text: `diagnostics: ${failed} failed, ${passed} passed`,
        success: failed === 0,
        values: { passed, failed, warned },
        data: { actionName: "TRADE_DIAGNOSTICS", checks },
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await callback?.({
        text: `Diagnostics failed to run: ${msg}`,
        error: true,
      });
      return {
        text: "error",
        success: false,
        error: error instanceof Error ? error : new Error(msg),
      };
    }
  },

  examples: [
    [
      { name: "{{name1}}", content: { text: "run diagnostics" } },
      {
        name: "Astraeus",
        content: {
          text: "🩺 Trade diagnostics — all systems go (8 passed)\n✅ OpenRouter API key: configured\n…",
          actions: ["TRADE_DIAGNOSTICS"],
        },
      },
    ],
    [
      { name: "{{name1}}", content: { text: "health check" } },
      {
        name: "Astraeus",
        content: {
          text: "🩺 Trade diagnostics — 1 issue(s) found …",
          actions: ["TRADE_DIAGNOSTICS"],
        },
      },
    ],
  ],
};

export default diagnosticsAction;
