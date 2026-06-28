import {
  type Action,
  type ActionResult,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
  logger,
} from "@elizaos/core";
import {
  runSkillBundle,
  skillList,
  DEFAULT_LIQUIDATION_SKILLS,
} from "../skills/options-forecast/skill-bundle";
import { CmcDataProvider } from "../data/cmc";
import {
  buildAssetLiquidationMap,
  formatLiquidationMap,
} from "../skills/liquidation/levels";

const LIQ_SYMBOLS = ["BTC", "ETH", "BNB"] as const;

/**
 * Pull the REAL nearest-cluster numbers out of the CMC skill bundle (best-effort) so the
 * modelled ladder can be annotated with live exchange data: per-symbol "pool X% away
 * (Y× 7d avg)" and the current short-squeeze-fuel leader. Returns "" when unavailable.
 */
function extractLiveClusters(bundle: string | undefined): string {
  if (!bundle) return "";
  const parts: string[] = [];
  for (const sym of LIQ_SYMBOLS) {
    const m = new RegExp(
      `detect_liquidation_cluster_risk:${sym}:[^\\n]*?sits ([\\d.]+)% from the reference price[^\\n]*?are ([\\d.]+)\\s*[x×]`,
      "i",
    ).exec(bundle);
    if (m) parts.push(`${sym} ${m[1]}% away (${m[2]}× 7d avg)`);
  }
  const leader =
    /rank_short_squeeze_fuel_candidates:[^\n]*?\b([A-Z]{2,6})\b is the current lead item/i.exec(
      bundle,
    );
  const lines: string[] = [];
  if (parts.length) lines.push(`**Live CMC clusters:** ${parts.join(" · ")}`);
  if (leader) lines.push(`**Squeeze-fuel leader:** ${leader[1].toUpperCase()}`);
  return lines.join("\n");
}

/**
 * LIQUIDATION_ANALYSIS — market-wide liquidation/cascade read, useful after a sharp
 * move: cascade risk, liquidation clusters, short-squeeze fuel, volatility squeeze
 * release, and large-trade liquidity risk — via CMC skills.
 */
export const liquidationAction: Action = {
  name: "LIQUIDATION_ANALYSIS",
  similes: [
    "LIQUIDATION_RISK",
    "LIQUIDATION_CASCADE",
    "CASCADE_RISK",
    "SHORT_SQUEEZE",
    "AFTER_SHARP_MOVE",
  ],
  description:
    'Analyze market-wide LIQUIDATION / cascade risk after a sharp move (cascade risk, liquidation clusters, short-squeeze fuel) via CMC skills. Use for "liquidation analysis", "cascade risk", "liquidation after the dump/pump".',

  validate: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
  ): Promise<boolean> => {
    const t = (message.content?.text ?? "").toLowerCase();
    return (
      /\b(liquidation|cascade|short[\s-]?squeeze|squeeze)\b/.test(t) ||
      (/\bafter\b/.test(t) && /\b(sharp move|dump|pump|crash|spike)\b/.test(t))
    );
  },

  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State | undefined,
    _options: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    try {
      // NO intermediate "mapping…" callback. ElizaOS buffers every action callback() and
      // flushes them all at the END with the SAME responseId (processActions →
      // storageCallback), so a progress note never shows live AND it claims message-id=R
      // first — the final map then re-uses id=R and the GUI dedups it, leaving the result
      // invisible until a manual Ctrl+R. One final callback (below) broadcasts as a fresh
      // message that renders live; the "thinking" indicator covers the wait.
      // Price/vol (fast, reliable REST) drives the modelled ladder; the CMC skill bundle
      // (slow, sometimes 502s) only annotates it with live cluster data — run in parallel
      // so a slow/failed skill probe never delays the map.
      const cmc = new CmcDataProvider();
      const [signals, skillCtx] = await Promise.all([
        cmc.getTokenSignals([...LIQ_SYMBOLS]),
        runSkillBundle(
          runtime,
          skillList("LIQUIDATION_SKILLS", DEFAULT_LIQUIDATION_SKILLS),
          {},
          { force: true, symbols: [...LIQ_SYMBOLS] },
        ).catch(() => undefined),
      ]);

      const maps = signals
        .filter((s) => s.priceUsd > 0)
        .map((s) =>
          buildAssetLiquidationMap(s.symbol, s.priceUsd, s.change24hPct),
        );
      if (maps.length === 0)
        throw new Error(
          "no live prices for BTC/ETH/BNB (CMC quote unavailable)",
        );

      const live = extractLiveClusters(skillCtx);
      const responseText = [
        "💥 **Liquidation map** — long & short levels with touch probability",
        "",
        formatLiquidationMap(maps),
        live ? `\n${live}` : "",
      ]
        .join("\n")
        .trim();
      await callback?.({
        text: responseText,
        actions: ["LIQUIDATION_ANALYSIS"],
      });
      return {
        text: "liquidation analyzed",
        success: true,
        data: { actionName: "LIQUIDATION_ANALYSIS" },
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error({ error: msg }, "LIQUIDATION_ANALYSIS failed");
      await callback?.({
        text: `Liquidation analysis failed: ${msg}`,
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
      {
        name: "{{name1}}",
        content: { text: "liquidation analysis after this dump" },
      },
      {
        name: "Astraeus",
        content: {
          text: "💥 Liquidation / cascade analysis …",
          actions: ["LIQUIDATION_ANALYSIS"],
        },
      },
    ],
  ],
};

export default liquidationAction;
