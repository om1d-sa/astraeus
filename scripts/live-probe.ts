/**
 * Live end-to-end probe: build each bundle's jobs through the REAL buildSkillJobs code
 * path and execute every skill against the CMC MCP server, classifying the outcome.
 *
 * Goal metric: SCHEMA errors (INVALID_ARGUMENT / missing-required / unsupported) should be
 * ~0 — that proves params are now correct. DATA-unavailable / blocked is the platform's
 * data surface, not our params. Run: bun scripts/live-probe.ts
 */
import { SKILL_BUNDLES, skillList } from "../src/skills/options-forecast/skill-bundle";
import { buildSkillJobs, type SkillCtx } from "../src/skills/options-forecast/skill-schemas";

const URL = "https://mcp.coinmarketcap.com/skill-hub/stream";
const KEY = process.env.CMC_MCP_API_KEY ?? "0f0e0210a368485ab81b0fa2119c6f43";
const TIMEOUT_MS = Number(process.env.CMC_SKILLS_TIMEOUT_MS ?? 150_000);
const CONCURRENCY = 20;

type Cat = "ok" | "schema" | "data" | "timeout" | "other";

async function execute(name: string, params: Record<string, unknown>): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(URL, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "X-CMC-MCP-API-KEY": KEY,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "execute_skill", arguments: { unique_name: name, parameters: params } },
      }),
    });
    const raw = await res.text();
    for (const line of raw.split("\n")) {
      if (line.startsWith("data:")) {
        const r = JSON.parse(line.slice(5).trim());
        return r?.result?.content?.[0]?.text ?? JSON.stringify(r);
      }
    }
    return raw;
  } finally {
    clearTimeout(t);
  }
}

function classify(txt: string): { cat: Cat; reason: string } {
  // Drill into nested result.output (a JSON string) to find the deepest error.
  let node: unknown = (() => {
    try {
      return JSON.parse(txt);
    } catch {
      return txt;
    }
  })();
  const errOf = (j: unknown): { code: string; message: string } | undefined => {
    if (!j || typeof j !== "object") return undefined;
    const e = (j as Record<string, unknown>).error;
    if (e && typeof e === "object") {
      const o = e as Record<string, unknown>;
      if (o.code || o.message) return { code: String(o.code ?? ""), message: String(o.message ?? "") };
    }
    if (typeof e === "string" && e.trim()) return { code: "", message: e };
    return undefined;
  };
  let found: { code: string; message: string } | undefined;
  for (let i = 0; i < 5 && node && typeof node === "object"; i++) {
    found = errOf(node);
    if (found) break;
    const o = node as Record<string, unknown>;
    if (o.result && typeof o.result === "object") {
      found = errOf(o.result);
      if (found) break;
      node = o.result;
      continue;
    }
    if (typeof o.output === "string") {
      try {
        node = JSON.parse(o.output);
        continue;
      } catch {
        break;
      }
    }
    break;
  }
  if (!found) return { cat: "ok", reason: "evidence" };
  const blob = `${found.code} ${found.message}`;
  const reason = blob.trim().slice(0, 220);
  if (/INVALID_ARGUMENT|INVALID_PARAMS|required property|not accepted|UNSUPPORTED|must be a non-empty|Bad Request|validation/i.test(blob))
    return { cat: "schema", reason };
  if (/DATA_UNAVAILABLE|DATA_GAPS|unavailable|blocked|no data|not available|EXECUTION_ERROR|DISCOVERY_FAILED/i.test(blob))
    return { cat: "data", reason };
  return { cat: "other", reason };
}

function toCtx(params: Record<string, unknown>, symbols?: string[]): SkillCtx {
  const raw = (params.holdings ?? params.portfolio) as unknown;
  const holdings = Array.isArray(raw)
    ? (raw as Array<Record<string, unknown>>).map((h) => ({ symbol: String(h.symbol ?? ""), pct: Number(h.pct ?? 0) }))
    : undefined;
  return {
    symbol: typeof params.symbol === "string" ? params.symbol : undefined,
    symbols,
    holdings: holdings?.length ? holdings : undefined,
  };
}

// Build all jobs across bundles, de-duped globally by name+params to save credits.
const seen = new Map<string, { name: string; params: Record<string, unknown> }>();
const perBundle: Array<{ feature: string; keys: string[] }> = [];
for (const b of SKILL_BUNDLES) {
  const list = skillList(b.envKey, b.defaults);
  const ctx = toCtx(b.params ?? {}, b.symbols);
  const jobs = buildSkillJobs(list, ctx, (n) => ({ ...(b.params ?? {}) }));
  const keys: string[] = [];
  for (const j of jobs) {
    const key = `${j.name}|${JSON.stringify(j.params)}`;
    keys.push(key);
    if (!seen.has(key)) seen.set(key, { name: j.name, params: j.params });
  }
  perBundle.push({ feature: b.feature, keys });
}

const tasks = [...seen.entries()];
console.log(`Probing ${tasks.length} unique skill calls (deduped) across ${SKILL_BUNDLES.length} bundles…\n`);
const results = new Map<string, { cat: Cat; reason: string; ms: number }>();

let idx = 0;
async function worker() {
  while (idx < tasks.length) {
    const i = idx++;
    const [key, { name, params }] = tasks[i];
    const t0 = Date.now();
    try {
      const txt = await execute(name, params);
      results.set(key, { ...classify(txt), ms: Date.now() - t0 });
    } catch (e) {
      const ms = Date.now() - t0;
      const aborted = e instanceof Error && e.name === "AbortError";
      results.set(key, { cat: aborted ? "timeout" : "other", reason: String(e).slice(0, 90), ms });
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

const ICON: Record<Cat, string> = { ok: "✅", schema: "❌", data: "🟡", timeout: "⏱️", other: "⚠️" };
let totOk = 0, totSchema = 0, totAll = 0;
for (const { feature, keys } of perBundle) {
  let ok = 0, schema = 0;
  const lines: string[] = [];
  for (const key of keys) {
    const r = results.get(key)!;
    const name = key.split("|")[0];
    if (r.cat === "ok") ok++;
    if (r.cat === "schema") schema++;
    lines.push(`  ${ICON[r.cat]} ${name} — ${r.cat}${r.cat === "ok" ? "" : `: ${r.reason}`} (${r.ms}ms)`);
  }
  totOk += ok; totSchema += schema; totAll += keys.length;
  console.log(`\n### ${feature}: ${ok}/${keys.length} ok, ${schema} schema-error`);
  for (const l of lines) console.log(l);
}
console.log(`\n=== TOTAL: ${totOk}/${totAll} ok · ${totSchema} SCHEMA errors (target 0) ===`);
