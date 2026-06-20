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

// Count how many skills came back (one "[name]" block per returned skill).
function returnedCount(out: string | undefined): number {
  if (!out) return 0;
  return (out.match(/\n---\n/g)?.length ?? 0) + 1;
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
    const N = 29; // the market bundle size
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

describe("default skill bundles", () => {
  it("have the expected per-feature sizes and no duplicates", () => {
    const lists: Array<[string, string[], number]> = [
      ["MARKET", DEFAULT_MARKET_SKILLS, 29],
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
