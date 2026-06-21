import {
  type Action,
  type ActionResult,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
  logger,
} from "@elizaos/core";
import { TradingService, type DiagCheck } from "../agent/service";
import {
  SKILL_BUNDLES,
  type BundleSpec,
  type SkillProbeResult,
  mcpAvailable,
  probeSkillBundle,
  skillList,
  skillsEnabled,
} from "../skills/options-forecast/skill-bundle";

const ICON: Record<DiagCheck["status"], string> = {
  pass: "✅",
  fail: "❌",
  warn: "⚠️",
  info: "•",
};

const PROBE_ICON: Record<SkillProbeResult["status"], string> = {
  ok: "✅",
  error: "❌",
  timeout: "⏱️",
  empty: "∅",
};

const num = (key: string, fallback: number): number => {
  const v = process.env[key];
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
};

/** Map a feature keyword in the message to its bundle, so "debug research skills"
 *  probes only the research bundle. No keyword match → probe every bundle. */
const BUNDLE_KEYWORDS: Record<string, RegExp> = {
  "Overall market": /\bmarket\b/,
  "Trending cryptos": /\btrend/,
  "Crypto research": /\bresearch\b/,
  "Portfolio analysis": /\bportfolio\b/,
  "Liquidation analysis": /\b(liquidation|cascade|squeeze)\b/,
  "Forecast ETF leg": /\b(etf|forecast)\b/,
};

function selectBundles(text: string): {
  bundles: readonly BundleSpec[];
  targeted: boolean;
} {
  const picked = SKILL_BUNDLES.filter((b) =>
    BUNDLE_KEYWORDS[b.feature]?.test(text),
  );
  return picked.length
    ? { bundles: picked, targeted: true }
    : { bundles: SKILL_BUNDLES, targeted: false };
}

/**
 * AGENT_DEBUG — one comprehensive debug report across EVERY agent feature.
 *
 * Extends the trade-only TRADE_DIAGNOSTICS into a full agent self-report: core
 * systems (config, market data, forecast engine, execution, x402, loop state),
 * the CMC skill bundles behind MARKET / TRENDING / RESEARCH / PORTFOLIO /
 * LIQUIDATION / the forecast ETF leg, and the ERC-8004 identity feature.
 *
 * Skill bundles get special treatment: ask to "debug skill bundles" (or a single
 * feature, e.g. "debug research skills") and it LIVE-probes each skill via
 * execute_skill, reporting per-skill ok / error / timeout / empty — surfacing
 * exactly which CMC skills return usable data vs error on their inputs. The live
 * probe spends CMC credits, so it is opt-in (mentions of skill/bundle/probe).
 */
export const agentDebugAction: Action = {
  name: "AGENT_DEBUG",
  similes: [
    "DEBUG",
    "DEBUG_REPORT",
    "AGENT_DEBUG_REPORT",
    "DEBUG_SKILLS",
    "DEBUG_SKILL_BUNDLES",
    "PROBE_SKILLS",
    "FULL_DIAGNOSTICS",
  ],
  description:
    'Full agent debug report across every feature (config, data, forecast, execution, x402, autonomous loop, ERC-8004 identity) with a special live probe of the CMC skill bundles. Use for "debug", "debug report", "agent debug", "debug skill bundles", "debug research skills", "probe skills". For the trade engine only, use TRADE_DIAGNOSTICS.',

  validate: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
  ): Promise<boolean> => {
    const t = (message.content?.text ?? "").toLowerCase();
    if (/\bskill[\s-]*bundles?\b/.test(t)) return true;
    if (/\b(probe|diagnose)\s+(the\s+)?skills?\b/.test(t)) return true;
    if (!/\bdebug\b/.test(t)) return false;
    // "debug trade/trading" alone is the trade engine's job (TRADE_DIAGNOSTICS);
    // every other "debug …" (report / skills / a feature / bare debug) is ours.
    const tradeOnly =
      /\bdebug\b\s+(the\s+)?(trade|trading)\b/.test(t) &&
      !/\b(skill|bundle|report|agent|everything|all|full|feature)\b/.test(t);
    return !tradeOnly;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined,
    _options: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const t = (message.content?.text ?? "").toLowerCase();
    const wantsProbe = /\b(skill|bundle|probe|live|deep)\b/.test(t);
    const probeAll = /\b(all|every|everything|full|exhaustive)\b/.test(t);
    const lines: string[] = ["🧪 **Astraeus agent debug report**"];

    try {
      await callback?.({
        text: "🧪 Running agent debug report (live probes — this can take ~10–30s)…",
      });

      // --- 1) Core systems (reuses the trade-diagnostics live probes) ---
      const svc = runtime.getService(
        TradingService.serviceType,
      ) as unknown as TradingService | null;
      lines.push("\n**Core systems**");
      if (!svc) {
        lines.push("❌ Trading service unavailable (plugin not loaded?)");
      } else {
        try {
          const checks = await svc.runDiagnostics();
          const failed = checks.filter((c) => c.status === "fail").length;
          lines.push(
            failed === 0 ? "✅ all core checks passed" : `❌ ${failed} issue(s)`,
          );
          for (const c of checks)
            lines.push(`${ICON[c.status]} ${c.name}: ${c.detail}`);
        } catch (e) {
          lines.push(
            `❌ core diagnostics failed: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }

      // --- 2) CMC skill bundles (inventory; always shown, no API calls) ---
      const mcpOk = mcpAvailable(runtime);
      lines.push("\n**CMC skill bundles**");
      lines.push(
        `${mcpOk ? "✅" : "❌"} MCP (cmc-skill-hub): ${mcpOk ? "available" : "NOT available — is @elizaos/plugin-mcp loaded and the cmc-skill-hub server configured?"}`,
      );
      lines.push(
        `${skillsEnabled() ? "✅" : "•"} CMC_SKILLS_ENABLED: ${skillsEnabled() ? "on" : "off (auto-enrichment skipped; PORTFOLIO/LIQUIDATION still force-run)"}`,
      );
      for (const b of SKILL_BUNDLES) {
        const list = skillList(b.envKey, b.defaults);
        const overridden = !!process.env[b.envKey]?.trim();
        lines.push(
          `• ${b.feature} — ${list.length} skill(s) via ${b.envKey} ${overridden ? "(env override)" : "(defaults)"}`,
        );
      }

      // --- 3) Live skill probe (opt-in; spends CMC credits) ---
      if (wantsProbe && mcpOk) {
        const { bundles, targeted } = selectBundles(t);
        const limit = probeAll ? 0 : num("DEBUG_SKILL_PROBE_LIMIT", 3);
        lines.push(
          `\n**Live skill probe** — ${targeted ? "targeted bundle(s)" : "all bundles"}, ${limit ? `first ${limit}/bundle` : "every skill"}, via execute_skill (spends CMC credits):`,
        );
        const probed = await Promise.all(
          bundles.map(async (b) => {
            const list = skillList(b.envKey, b.defaults);
            const results = await probeSkillBundle(runtime, list, b.params ?? {}, {
              symbols: b.symbols,
              perSkillParams: b.perSkillParams,
              limit: limit || undefined,
            });
            return { b, results };
          }),
        );
        for (const { b, results } of probed) {
          const ok = results.filter((r) => r.status === "ok").length;
          lines.push(`\n${b.feature}: ${ok}/${results.length} ok`);
          for (const r of results)
            lines.push(`  ${PROBE_ICON[r.status]} ${r.skill} — ${r.detail} (${r.ms}ms)`);
        }
      } else if (wantsProbe && !mcpOk) {
        lines.push("\n⚠️ Skipping live skill probe — MCP service unavailable.");
      } else {
        lines.push(
          '\nℹ️ Say "debug skill bundles" (or e.g. "debug research skills") to LIVE-probe each CMC skill — that calls execute_skill and spends CMC credits.',
        );
      }

      // --- 4) ERC-8004 identity feature ---
      const idOn =
        (process.env.ERC8004_IDENTITY_ENABLED ?? "true").toLowerCase() !==
        "false";
      lines.push("\n**Agent identity (ERC-8004)**");
      lines.push(
        `${idOn ? "✅" : "•"} AGENT_IDENTITY command: ${idOn ? "enabled" : "disabled (ERC8004_IDENTITY_ENABLED=false)"}`,
      );

      // Cap the report so the message bus can always persist it — a very large reply
      // (e.g. a full live probe) can fail the central_messages insert and never render.
      // The complete report is always in the backend log regardless.
      const MAX = 3500;
      const full = lines.join("\n");
      const report =
        full.length > MAX
          ? `${full.slice(0, MAX)}\n…(truncated — see the terminal log for the full report)`
          : full;
      await callback?.({ text: report, actions: ["AGENT_DEBUG"] });
      return {
        text: "agent debug report",
        success: true,
        data: { actionName: "AGENT_DEBUG" },
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error({ error: msg }, "AGENT_DEBUG failed");
      await callback?.({
        text: `Agent debug report failed to run: ${msg}`,
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
      { name: "{{name1}}", content: { text: "agent debug report" } },
      {
        name: "Astraeus",
        content: {
          text: "🧪 **Astraeus agent debug report**\n**Core systems**\n✅ all core checks passed\n…",
          actions: ["AGENT_DEBUG"],
        },
      },
    ],
    [
      { name: "{{name1}}", content: { text: "debug skill bundles" } },
      {
        name: "Astraeus",
        content: {
          text: "🧪 **Astraeus agent debug report**\n…\n**Live skill probe**\nOverall market: 2/3 ok\n  ✅ daily_market_overview — 1843 chars (5210ms)\n…",
          actions: ["AGENT_DEBUG"],
        },
      },
    ],
  ],
};

export default agentDebugAction;
