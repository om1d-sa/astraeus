import { type IAgentRuntime, type Action, logger } from "@elizaos/core";
import {
  synthesizeVerdict,
  type TimeframeReading,
} from "../../skills/research/timeframes";
import {
  pickBullishAltcoin,
  shouldDivertToAltcoins,
  type AltcoinCandidate,
} from "../../skills/altcoin-scan/scan";
import {
  TIMEFRAME_MS,
  hasCustomWithdrawTimeline,
  withdrawTimelineMs,
} from "../../skills/withdraw/timeline";
import { BSC_CONTRACTS, bscContractFor } from "../../config/bsc-contracts";
import { buildSwapArgs } from "../../exec/twak";
import { TradingService } from "../../agent/service";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
      name: "research_multi_timeframe_verdict_is_deterministic",
      fn: async (_runtime: IAgentRuntime) => {
        // The RESEARCH card blends 1h/4h/daily/weekly technicals into one verdict. This
        // exercises that pure core end-to-end (no network/credits) so a regression in the
        // multi-timeframe scoring surfaces in the live test suite, not just unit tests.
        const r = (
          label: TimeframeReading["label"],
          rsi14: number,
          macd: number,
        ): TimeframeReading => ({
          label,
          rsi14,
          macd,
          lastClose: 100,
          volPct: 0.03,
          points: 60,
        });
        const bull = synthesizeVerdict(
          [
            r("1h", 68, 1),
            r("4h", 70, 1.2),
            r("1D", 72, 1.6),
            r("1W", 65, 0.8),
          ],
          100,
        );
        if (bull.bias !== "bullish") {
          throw new Error(`expected bullish verdict, got "${bull.bias}"`);
        }
        if (!(bull.confidence > 0 && bull.confidence <= 1)) {
          throw new Error(`confidence out of range: ${bull.confidence}`);
        }
        if (!(bull.targetPrice && bull.targetPrice > 100)) {
          throw new Error(
            "expected an upside target above spot for a bullish read",
          );
        }
        const empty = synthesizeVerdict([], 100);
        if (empty.bias !== "neutral" || empty.confidence !== 0) {
          throw new Error("empty input should yield a zero-confidence neutral");
        }
        logger.info(
          `✓ Multi-timeframe verdict deterministic (bull conf ${(bull.confidence * 100).toFixed(0)}%, target $${bull.targetPrice?.toFixed(2)})`,
        );
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
      name: "custom_withdraw_timeline_resolution_is_deterministic",
      fn: async (_runtime: IAgentRuntime) => {
        // The custom withdraw timeline lets the operator override how long each loop holds a
        // position before auto-close, per loop, via an ON/OFF switch + a duration (SHORTER or
        // LONGER than the timeframe; units like "3d"/"8h"). Exercise the pure core end-to-end
        // (no network/credits): switch off → timeframe default; switch on with a value → that
        // value wins (incl. a hold LONGER than the timeframe); and the two loops are independent.
        const KEYS = [
          "AUTONOMOUS_WITHDRAW_TIMELINE_ENABLED",
          "AUTONOMOUS_WITHDRAW_TIMELINE",
          "TRACK1_ALTCOIN_WITHDRAW_TIMELINE_ENABLED",
          "TRACK1_ALTCOIN_WITHDRAW_TIMELINE",
        ];
        const savedEnv = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
        const set = (k: string, v: string | undefined) => {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        };
        try {
          for (const k of KEYS) delete process.env[k];
          if (hasCustomWithdrawTimeline("main") || hasCustomWithdrawTimeline("alt")) {
            throw new Error("switches off must report no custom withdraw timeline");
          }
          if (
            withdrawTimelineMs("main", "daily") !== TIMEFRAME_MS.daily ||
            withdrawTimelineMs("alt", "hourly") !== TIMEFRAME_MS.hourly
          ) {
            throw new Error("switches off must fall back to the timeframe default");
          }

          // A value with the switch OFF must stay inert.
          set("AUTONOMOUS_WITHDRAW_TIMELINE", "8h");
          if (withdrawTimelineMs("main", "daily") !== TIMEFRAME_MS.daily) {
            throw new Error("a value with the switch off must do nothing");
          }

          // Switch ON the ALT loop with a hold LONGER than its timeframe (3d > 24h daily).
          set("TRACK1_ALTCOIN_WITHDRAW_TIMELINE_ENABLED", "true");
          set("TRACK1_ALTCOIN_WITHDRAW_TIMELINE", "3d");
          if (withdrawTimelineMs("alt", "daily") !== 259_200_000) {
            throw new Error('alt "3d" override must resolve to 3 days');
          }
          if (!(withdrawTimelineMs("alt", "daily") > TIMEFRAME_MS.daily)) {
            throw new Error("a LONGER override must extend the hold past the timeframe");
          }
          if (withdrawTimelineMs("main", "daily") !== TIMEFRAME_MS.daily) {
            throw new Error("alt override must NOT bleed into the main loop");
          }

          // Switch ON the MAIN loop independently with a SHORTER hold (8h < 24h daily).
          set("AUTONOMOUS_WITHDRAW_TIMELINE_ENABLED", "true");
          if (
            withdrawTimelineMs("main", "daily") !== 28_800_000 ||
            withdrawTimelineMs("alt", "daily") !== 259_200_000
          ) {
            throw new Error("the two loop overrides must resolve independently");
          }
          logger.info(
            "✓ Custom withdraw timeline resolves per-loop (switch-gated, shorter AND longer, independent)",
          );
        } finally {
          for (const k of KEYS) set(k, savedEnv[k]);
        }
      },
    },

    {
      name: "custom_withdraw_timeline_config_is_exposed",
      fn: async (runtime: IAgentRuntime) => {
        const service = runtime.getService("astraeus-trading") as unknown as {
          withdrawTimelineMainMs?: number;
          withdrawTimelineAltMs?: number;
          getStatus?: () => Promise<{
            withdrawTimelineMainMs?: number;
            withdrawTimelineAltMs?: number;
          }>;
        } | null;
        if (!service?.getStatus) {
          logger.info(
            "⚠ service not registered (missing COINMARKETCAP_API_KEY?) — skipping withdraw-timeline check",
          );
          return;
        }
        // The override is optional (undefined when unset), but the FIELDS must exist on the
        // service and round-trip through getStatus() so the status view can render them.
        const okType = (v: unknown) => v === undefined || typeof v === "number";
        if (
          !okType(service.withdrawTimelineMainMs) ||
          !okType(service.withdrawTimelineAltMs)
        ) {
          throw new Error(
            "withdraw-timeline overrides not exposed as number|undefined on the service",
          );
        }
        const st = await service.getStatus();
        if (
          !okType(st.withdrawTimelineMainMs) ||
          !okType(st.withdrawTimelineAltMs)
        ) {
          throw new Error(
            "getStatus() did not surface the withdraw-timeline fields",
          );
        }
        const fmt = (v?: number) => (v ? `${Math.round(v / 60_000)}m` : "default");
        logger.info(
          `✓ withdraw-timeline config exposed (main ${fmt(service.withdrawTimelineMainMs)}, alt ${fmt(service.withdrawTimelineAltMs)})`,
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
          throw new Error(
            "getPositions() report is missing aggregate PnL fields",
          );
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
      name: "track1_altcoin_scan_core_is_deterministic",
      fn: async (_runtime: IAgentRuntime) => {
        // The Track-1 high-risk altcoin diversion rests on three pure pieces: the divert
        // rule (bullish/sideways ETH → hunt altcoins), the first-bullish-≥-threshold pick,
        // and the baked BSC contract map the live swap routes by. Exercise them end-to-end
        // (no network/credits) so a regression surfaces in the live suite, not just units.
        if (
          !shouldDivertToAltcoins("up") ||
          !shouldDivertToAltcoins("sideways")
        ) {
          throw new Error(
            "expected up/sideways ETH forecasts to divert to the altcoin scan",
          );
        }
        if (shouldDivertToAltcoins("down")) {
          throw new Error("a DOWN ETH forecast must not divert to altcoins");
        }
        const c = (
          symbol: string,
          bias: AltcoinCandidate["bias"],
          confidence: number,
        ): AltcoinCandidate => ({ symbol, bias, confidence, priceUsd: 1 });
        const chosen = pickBullishAltcoin(
          [
            c("CAKE", "neutral", 0.9),
            c("MYX", "bullish", 0.7),
            c("AAVE", "bullish", 0.95),
          ],
          { minConfidencePct: 60, depth: 5 },
        );
        if (chosen?.symbol !== "MYX") {
          throw new Error(
            `expected first bullish≥60% pick MYX, got ${chosen?.symbol}`,
          );
        }
        // The baked map must route a generic ticker by its real BSC address, and keep the
        // cash leg (ETH/USDT) and the genuinely no-BSC L1s (H/IP) unmapped → symbol fallback.
        const addr = bscContractFor("MYX");
        if (!addr || !/^0x[0-9a-fA-F]{40}$/.test(addr)) {
          throw new Error(
            "MYX did not resolve to a well-formed BSC address in the baked map",
          );
        }
        if (
          bscContractFor("ETH") ||
          bscContractFor("USDT") ||
          bscContractFor("H")
        ) {
          throw new Error("ETH/USDT/H must be unmapped (route by symbol)");
        }
        const args = buildSwapArgs(
          {
            fromSymbol: "USDT",
            toSymbol: "MYX",
            toAddress: addr,
            amountUsd: 5,
            maxSlippageBps: 100,
          },
          { chain: "bsc", slippagePct: 1, useContract: true },
        );
        if (args[2] !== addr) {
          throw new Error(
            "buildSwapArgs did not route the BUY leg by contract address",
          );
        }
        logger.info(
          `✓ Track-1 altcoin scan core deterministic (${Object.keys(BSC_CONTRACTS).length} baked BSC contracts)`,
        );
      },
    },

    {
      name: "track1_altcoin_position_survives_restart_and_sells_at_live_price",
      fn: async (runtime: IAgentRuntime) => {
        // Whole-workflow restart check on a real TradingService (paper mode → no real funds /
        // network). A live altcoin position left open by a prior run must be RECOVERED on
        // restart with its baked BSC contract address intact, and its sell-back must be sized
        // off the CURRENT on-chain price (with the close haircut) — NEVER the entry price —
        // and routed by the contract address. Identical machinery to the ETH main loop.
        const savedEnv: Record<string, string | undefined> = {};
        const setEnv = (k: string, v: string) => {
          savedEnv[k] = process.env[k];
          process.env[k] = v;
        };
        setEnv("ENABLE_LIVE_TRADING", "false"); // paper executor
        if (!process.env.COINMARKETCAP_API_KEY)
          setEnv("COINMARKETCAP_API_KEY", "test-key");
        setEnv("CLOSE_SELL_HAIRCUT_BPS", "50"); // 0.5%
        setEnv(
          "ASTRAEUS_STATE_DIR",
          mkdtempSync(join(tmpdir(), "astraeus-e2e-altcoin-")),
        );
        const dir = process.env.ASTRAEUS_STATE_DIR as string;

        const entryPrice = 0.1;
        const boughtAmount = 50;
        const addr = BSC_CONTRACTS.MYX;
        try {
          // A live altcoin position left open by a prior run (carries its BSC contract address),
          // still in-window (closeAt in the future) so the restart RE-ARMS rather than closes.
          writeFileSync(
            join(dir, "open-trades-paper.json"),
            JSON.stringify([
              {
                id: "ft-e2e-altcoin",
                asset: "MYX",
                timeframe: "hourly",
                sizeUsd: 5,
                entryPrice,
                boughtAmount,
                openedAt: Date.now() - 600_000,
                closeAt: Date.now() + 3_600_000,
                address: addr,
              },
            ]),
          );
          // The recovered wallet still holds the MYX so the sell-back can settle.
          writeFileSync(
            join(dir, "paper-portfolio.json"),
            JSON.stringify({
              cashUsd: 0,
              holdings: [{ symbol: "MYX", amount: boughtAmount }],
            }),
          );

          const svc = new TradingService(runtime);

          // Stub the live price ($0.20 — DOUBLE the entry) and capture the sell request. Plain
          // monkey-patches (no test framework) so this runs under the real e2e runtime.
          const provider = (
            svc as unknown as {
              provider?: { getTokenSignals: (s: string[]) => Promise<unknown> };
            }
          ).provider;
          if (!provider)
            throw new Error("TradingService has no provider (COINMARKETCAP_API_KEY?)");
          provider.getTokenSignals = async () => [
            { symbol: "MYX", priceUsd: 0.2 },
          ];
          const exec = (
            svc as unknown as {
              executor: { swap: (r: Record<string, unknown>) => Promise<unknown> };
            }
          ).executor;
          const origSwap = exec.swap.bind(exec);
          let sell: Record<string, unknown> | undefined;
          exec.swap = async (req: Record<string, unknown>) => {
            sell = req;
            return origSwap(req);
          };

          // "Restart": reconcile recovers the open position from disk and re-arms its timer.
          (svc as unknown as { reconcileOpenTrades: () => void }).reconcileOpenTrades();
          const trades = (
            svc as unknown as {
              forecastTrades: Map<string, { address?: string }>;
            }
          ).forecastTrades;
          const restored = trades.get("ft-e2e-altcoin");
          if (!restored)
            throw new Error("restart did not recover the open altcoin position");
          if (restored.address !== addr)
            throw new Error("restart lost the altcoin's BSC contract address");

          // Close it: routes by the restored address, sized off the CURRENT $0.20 price (not
          // the $0.10 entry), with the 0.5% haircut.
          await (
            svc as unknown as {
              closeForecastTrade: (id: string) => Promise<void>;
            }
          ).closeForecastTrade("ft-e2e-altcoin");
          if (!sell) throw new Error("close did not execute a sell-back swap");
          if (sell.fromSymbol !== "MYX" || sell.toSymbol !== "USDT")
            throw new Error("sell-back leg is not MYX→USDT");
          if (sell.fromAddress !== addr)
            throw new Error(
              "sell-back did not route by the restored BSC contract address",
            );
          const expected = boughtAmount * 0.2 * (1 - 0.005);
          if (Math.abs((sell.amountUsd as number) - expected) > 1e-6)
            throw new Error(
              `sell sized off the wrong price: amountUsd=${sell.amountUsd}, expected≈${expected} (current price × haircut)`,
            );
          if (trades.has("ft-e2e-altcoin"))
            throw new Error("position was not removed after a successful close");

          for (const h of (
            svc as unknown as {
              timers: Map<string, ReturnType<typeof setTimeout>>;
            }
          ).timers.values())
            clearTimeout(h);

          logger.info(
            "✓ Track-1 altcoin position survives restart, recovers its contract address, and sells back at the live price",
          );
        } finally {
          for (const [k, v] of Object.entries(savedEnv)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
          }
        }
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
