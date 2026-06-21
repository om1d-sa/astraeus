import {
  describe,
  expect,
  it,
  beforeEach,
  afterEach,
  spyOn,
  beforeAll,
} from "bun:test";
import { logger, type IAgentRuntime } from "@elizaos/core";
import {
  runSkillBundle,
  probeSkillBundle,
  extractSkillSummary,
  synthesizeSkillSentiment,
  mcpAvailable,
  SKILL_BUNDLES,
  DEFAULT_MARKET_SKILLS,
  DEFAULT_TRENDING_SKILLS,
  DEFAULT_RESEARCH_SKILLS,
  DEFAULT_PORTFOLIO_SKILLS,
  DEFAULT_LIQUIDATION_SKILLS,
  DEFAULT_ETF_SKILLS,
} from "../skills/options-forecast/skill-bundle";

/**
 * Skill-bundle tests — verify the SLOW CMC skill bundles run all skills in PARALLEL,
 * are bounded per-skill by CMC_SKILLS_TIMEOUT_MS, drop slow/failed skills without
 * failing the whole bundle, and respect the CMC_SKILLS_ENABLED / force gating.
 *
 * Uses a MOCK MCP service — no real CoinMarketCap calls, so it spends ZERO API credits.
 * (It also serves as the credit-free "do the bundles have enough time?" timing demo.)
 */

beforeAll(() => {
  spyOn(logger, "info");
  spyOn(logger, "warn");
  spyOn(logger, "error");
});

// A fake runtime whose MCP `execute_skill` resolves after a simulated latency.
function mockRuntime(
  latencyMs: (name: string) => number,
  errorFor?: (name: string) => boolean,
): IAgentRuntime {
  const mcp = {
    async callTool(_server: string, _tool: string, args?: Record<string, unknown>) {
      const name = String((args as { unique_name?: string })?.unique_name ?? "");
      await new Promise((r) => setTimeout(r, latencyMs(name)));
      if (errorFor?.(name)) return { isError: true, content: [] };
      return { content: [{ text: `MOCK evidence pack for ${name}` }] };
    },
  };
  return { getService: () => mcp } as unknown as IAgentRuntime;
}

// Count how many skills came back (one "• name: …" bullet line per returned skill).
function returnedCount(out: string | undefined): number {
  if (!out) return 0;
  return out.match(/^• /gm)?.length ?? 0;
}

const names = (n: number) => Array.from({ length: n }, (_, i) => `skill_${i}`);

describe("runSkillBundle", () => {
  let savedEnabled: string | undefined;
  let savedTimeout: string | undefined;

  beforeEach(() => {
    savedEnabled = process.env.CMC_SKILLS_ENABLED;
    savedTimeout = process.env.CMC_SKILLS_TIMEOUT_MS;
  });
  afterEach(() => {
    if (savedEnabled === undefined) delete process.env.CMC_SKILLS_ENABLED;
    else process.env.CMC_SKILLS_ENABLED = savedEnabled;
    if (savedTimeout === undefined) delete process.env.CMC_SKILLS_TIMEOUT_MS;
    else process.env.CMC_SKILLS_TIMEOUT_MS = savedTimeout;
  });

  it("runs ALL skills in parallel — total ≈ slowest, not the sum", async () => {
    process.env.CMC_SKILLS_TIMEOUT_MS = "2000";
    const N = 29; // a large bundle — exercise heavy parallel fan-out
    const rt = mockRuntime(() => 100); // each "skill" takes 100ms
    const t0 = Date.now();
    const out = await runSkillBundle(rt, names(N), {}, { force: true });
    const elapsed = Date.now() - t0;

    expect(returnedCount(out)).toBe(N); // all 29 returned
    // Serial would be ~29 * 100ms = 2900ms; parallel is ~100ms. Generous CI margin.
    expect(elapsed).toBeLessThan(1500);
  });

  it("drops skills that exceed the per-skill timeout WITHOUT failing the bundle", async () => {
    process.env.CMC_SKILLS_TIMEOUT_MS = "300";
    // skills 0,1,2 take 600ms (> 300ms timeout) → dropped; the rest take 50ms → returned.
    const rt = mockRuntime((n) => (Number(n.split("_")[1]) < 3 ? 600 : 50));
    const out = await runSkillBundle(rt, names(10), {}, { force: true });
    expect(returnedCount(out)).toBe(7); // 10 - 3 timed-out
  });

  it("drops skills that error WITHOUT failing the bundle", async () => {
    process.env.CMC_SKILLS_TIMEOUT_MS = "1000";
    const rt = mockRuntime(
      () => 20,
      (n) => n === "skill_0" || n === "skill_1", // these two return isError
    );
    const out = await runSkillBundle(rt, names(5), {}, { force: true });
    expect(returnedCount(out)).toBe(3); // 5 - 2 errored
  });

  it("drops skills whose PAYLOAD is an error (not the transport isError flag)", async () => {
    process.env.CMC_SKILLS_ENABLED = "true";
    // CMC returns validation/skill errors as a *successful* MCP response whose
    // text is a JSON error envelope — two shapes seen in the wild.
    const payloadFor = (name: string): string =>
      name === "skill_0"
        ? JSON.stringify({
            result: {},
            error: {
              code: "INVALID_ARGUMENT",
              message: "required property 'preview' not found",
            },
          })
        : name === "skill_1"
          ? JSON.stringify({
              result: { error: "", exitCode: 1, output: "{}", success: false },
            })
          : `{"skill":"${name}","result":{"type":"evidence_pack","data":{"status":"ok"}}}`;
    const rt = {
      getService: () => ({
        async callTool(
          _s: string,
          _t: string,
          args?: Record<string, unknown>,
        ) {
          const name = String(
            (args as { unique_name?: string })?.unique_name ?? "",
          );
          return { content: [{ text: payloadFor(name) }] };
        },
      }),
    } as unknown as IAgentRuntime;
    const out = await runSkillBundle(rt, names(5), {});
    expect(returnedCount(out)).toBe(3); // skill_0 (validation) + skill_1 (exitCode 1) dropped
  });

  it("fans symbol skills across opts.symbols and applies per-skill param overrides", async () => {
    process.env.CMC_SKILLS_ENABLED = "true";
    const calls: Array<{ name: string; params: Record<string, unknown> }> = [];
    const rt = {
      getService: () => ({
        async callTool(
          _s: string,
          _t: string,
          args?: Record<string, unknown>,
        ) {
          const a = args as {
            unique_name?: string;
            parameters?: Record<string, unknown>;
          };
          calls.push({
            name: String(a?.unique_name ?? ""),
            params: a?.parameters ?? {},
          });
          return { content: [{ text: '{"result":{"data":{"status":"ok"}}}' }] };
        },
      }),
    } as unknown as IAgentRuntime;
    const list = [
      "detect_perp_momentum_exhaustion", // symbol skill → fanned
      "compare_etf_flow_quality", // per-skill override
      "daily_market_overview", // plain
    ];
    const out = await runSkillBundle(
      rt,
      list,
      { preview: true },
      {
        symbols: ["BTC", "ETH", "BNB"],
        perSkillParams: { compare_etf_flow_quality: { assets: ["BTC", "ETH"] } },
      },
    );
    expect(returnedCount(out)).toBe(5); // 3 (fanned) + 1 + 1

    // Symbol skill ran once per major, each carrying the shared `preview` param.
    const sym = calls.filter((c) => c.name === "detect_perp_momentum_exhaustion");
    expect(sym.map((c) => c.params.symbol).sort()).toEqual(["BNB", "BTC", "ETH"]);
    expect(sym.every((c) => c.params.preview === true)).toBe(true);
    expect(out).toContain("detect_perp_momentum_exhaustion:BTC");

    // Per-skill override merged on top of the shared params.
    const etf = calls.find((c) => c.name === "compare_etf_flow_quality");
    expect(etf?.params.assets).toEqual(["BTC", "ETH"]);
    expect(etf?.params.preview).toBe(true);

    // Plain skill: shared params only, never gets a symbol.
    const plain = calls.find((c) => c.name === "daily_market_overview");
    expect(plain?.params.symbol).toBeUndefined();
  });

  it("is gated OFF when CMC_SKILLS_ENABLED is unset and not forced", async () => {
    delete process.env.CMC_SKILLS_ENABLED;
    const out = await runSkillBundle(mockRuntime(() => 5), names(3), {});
    expect(out).toBeUndefined();
  });

  it("runs when CMC_SKILLS_ENABLED=true (no force needed)", async () => {
    process.env.CMC_SKILLS_ENABLED = "true";
    const out = await runSkillBundle(mockRuntime(() => 5), names(3), {});
    expect(returnedCount(out)).toBe(3);
  });

  it("force:true bypasses the master toggle (PORTFOLIO / LIQUIDATION path)", async () => {
    process.env.CMC_SKILLS_ENABLED = "false";
    const out = await runSkillBundle(mockRuntime(() => 5), names(3), {}, { force: true });
    expect(returnedCount(out)).toBe(3);
  });

  it("returns undefined when the MCP service is unavailable", async () => {
    process.env.CMC_SKILLS_ENABLED = "true";
    const noMcp = { getService: () => null } as unknown as IAgentRuntime;
    const out = await runSkillBundle(noMcp, names(3), {});
    expect(out).toBeUndefined();
  });
});

describe("probeSkillBundle (AGENT_DEBUG skill-bundle debug)", () => {
  // A runtime whose execute_skill returns ok / error-payload / empty per skill name,
  // so we can assert the probe classifies each outcome (no real CMC calls).
  function probeRuntime(): IAgentRuntime {
    return {
      getService: () => ({
        async callTool(_s: string, _t: string, args?: Record<string, unknown>) {
          const name = String(
            (args as { unique_name?: string })?.unique_name ?? "",
          );
          if (name === "skill_err")
            return {
              content: [
                {
                  text: JSON.stringify({
                    error: { code: "INVALID_ARGUMENT", message: "missing input" },
                  }),
                },
              ],
            };
          if (name === "skill_empty") return { content: [{ text: "" }] };
          return { content: [{ text: `OK evidence for ${name}` }] };
        },
      }),
    } as unknown as IAgentRuntime;
  }

  it("classifies each skill as ok / error / empty", async () => {
    const out = await probeSkillBundle(probeRuntime(), [
      "skill_ok",
      "skill_err",
      "skill_empty",
    ]);
    const byName = Object.fromEntries(out.map((r) => [r.skill, r.status]));
    expect(byName["skill_ok"]).toBe("ok");
    expect(byName["skill_err"]).toBe("error");
    expect(byName["skill_empty"]).toBe("empty");
    expect(out.every((r) => typeof r.ms === "number")).toBe(true);
  });

  it("respects opts.limit (caps how many jobs are probed)", async () => {
    const out = await probeSkillBundle(
      probeRuntime(),
      ["a", "b", "c", "d", "e"],
      {},
      { limit: 2 },
    );
    expect(out.length).toBe(2);
  });

  it("runs regardless of CMC_SKILLS_ENABLED (explicit debug action, no gate)", async () => {
    const saved = process.env.CMC_SKILLS_ENABLED;
    delete process.env.CMC_SKILLS_ENABLED;
    const out = await probeSkillBundle(probeRuntime(), ["skill_ok"]);
    expect(out[0]?.status).toBe("ok");
    if (saved === undefined) delete process.env.CMC_SKILLS_ENABLED;
    else process.env.CMC_SKILLS_ENABLED = saved;
  });

  it("returns [] and reports MCP unavailable when no MCP service", async () => {
    const noMcp = { getService: () => null } as unknown as IAgentRuntime;
    expect(await probeSkillBundle(noMcp, ["skill_ok"])).toEqual([]);
    expect(mcpAvailable(noMcp)).toBe(false);
  });
});

describe("extractSkillSummary", () => {
  it("pulls the summary out of a real double-encoded CMC payload", () => {
    // The shape CMC returns: {result:{output:"<json string with nested data.summary>"}}.
    const payload = JSON.stringify({
      result: {
        error: "",
        exitCode: 0,
        output: JSON.stringify({
          skill: "review_mean_reversion_setup",
          result: {
            type: "evidence_pack",
            data: { summary: "ON 4h mean-reversion state is stretched_but_not_exhausted." },
          },
        }),
      },
    });
    expect(extractSkillSummary(payload)).toBe(
      "ON 4h mean-reversion state is stretched_but_not_exhausted.",
    );
  });

  it("falls back to `conclusion` for skills with no `summary` (e.g. breakout scanner)", () => {
    const payload = JSON.stringify({
      result: {
        ok: true,
        data: {
          type: "evidence_pack",
          skill_id: "altcoin_breakout_scanner_spot",
          data: {
            status: "ok",
            decision_report: {
              title: "Spot Breakout Candidate Scan",
              conclusion: "SUP leads the breakout scan on technical strength.",
              analysis: "### Scan Overview\nlong markdown that should NOT be picked…",
            },
          },
        },
      },
    });
    expect(extractSkillSummary(payload)).toBe(
      "SUP leads the breakout scan on technical strength.",
    );
  });

  it("returns undefined when there is no summary/conclusion/decision field", () => {
    expect(
      extractSkillSummary('{"result":{"data":{"status":"ok"}}}'),
    ).toBeUndefined();
    expect(extractSkillSummary("not json at all")).toBeUndefined();
  });
});

describe("synthesizeSkillSentiment (skills feed the score)", () => {
  const rtWith = (modelOut: unknown): IAgentRuntime =>
    ({ useModel: async () => modelOut }) as unknown as IAgentRuntime;

  it("parses the LLM JSON into a sentiment + summary", async () => {
    const rt = rtWith(
      '{"sentiment": 0.7, "summary": "Funding cooling, ETF inflows resuming."}',
    );
    const out = await synthesizeSkillSentiment(rt, "CMC SKILL ANALYSES:\n• x", "ETH");
    expect(out?.sentiment).toBeCloseTo(0.7, 6);
    expect(out?.summary).toBe("Funding cooling, ETF inflows resuming.");
  });

  it("clamps out-of-range sentiment to [-1, 1]", async () => {
    expect(
      (await synthesizeSkillSentiment(rtWith('{"sentiment": 5, "summary": "x"}'), "x"))
        ?.sentiment,
    ).toBe(1);
    expect(
      (await synthesizeSkillSentiment(rtWith('{"sentiment": -9, "summary": "x"}'), "x"))
        ?.sentiment,
    ).toBe(-1);
  });

  it("returns undefined on empty input, bad JSON, missing summary, or a thrown model", async () => {
    expect(await synthesizeSkillSentiment(rtWith("{}"), "")).toBeUndefined(); // empty bundle
    expect(await synthesizeSkillSentiment(rtWith("not json"), "x")).toBeUndefined();
    expect(
      await synthesizeSkillSentiment(rtWith('{"sentiment": 0.3}'), "x"),
    ).toBeUndefined(); // no summary
    const boom = {
      useModel: async () => {
        throw new Error("LLM down");
      },
    } as unknown as IAgentRuntime;
    expect(await synthesizeSkillSentiment(boom, "x")).toBeUndefined();
  });
});

describe("SKILL_BUNDLES registry", () => {
  it("covers every feature bundle with a valid env key and non-empty defaults", () => {
    const features = SKILL_BUNDLES.map((b) => b.feature);
    expect(features).toContain("Overall market");
    expect(features).toContain("Crypto research");
    expect(features).toContain("Forecast ETF leg");
    for (const b of SKILL_BUNDLES) {
      expect(b.envKey).toMatch(/^[A-Z][A-Z0-9_]+$/);
      expect(b.defaults.length).toBeGreaterThan(0);
    }
  });
});

describe("default skill bundles", () => {
  it("have the expected per-feature sizes and no duplicates", () => {
    const lists: Array<[string, string[], number]> = [
      ["MARKET", DEFAULT_MARKET_SKILLS, 24],
      ["TRENDING", DEFAULT_TRENDING_SKILLS, 23],
      ["RESEARCH", DEFAULT_RESEARCH_SKILLS, 36],
      ["PORTFOLIO", DEFAULT_PORTFOLIO_SKILLS, 7],
      ["LIQUIDATION", DEFAULT_LIQUIDATION_SKILLS, 6],
      ["ETF", DEFAULT_ETF_SKILLS, 5],
    ];
    for (const [label, list, size] of lists) {
      expect({ [label]: list.length }).toEqual({ [label]: size });
      expect(new Set(list).size).toBe(list.length); // no dupes within a bundle
      for (const s of list) expect(s).toMatch(/^[a-z][a-z0-9_]+$/); // valid unique_names
    }
  });
});
