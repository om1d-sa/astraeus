import {
  type Action,
  type ActionResult,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  ModelType,
  type State,
  logger,
} from '@elizaos/core';
import { McpService } from '@elizaos/plugin-mcp';
import { SKILL_BUNDLES, skillList } from '../skills/options-forecast/skill-bundle';

const SERVER = 'cmc-skill-hub';

/** Minimal shape of the MCP service's callTool (avoids coupling to the plugin's full d.ts). */
type McpLike = {
  callTool(
    serverName: string,
    toolName: string,
    args?: Record<string, unknown>,
  ): Promise<{ isError?: boolean; content?: Array<{ type?: string; text?: string }> }>;
};

function contentToText(result: { content?: Array<{ type?: string; text?: string }> } | undefined): string {
  const content = result?.content;
  if (!Array.isArray(content)) return result ? JSON.stringify(result) : '';
  return content
    .map((c) => (typeof c?.text === 'string' ? c.text : JSON.stringify(c)))
    .join('\n')
    .trim();
}

/**
 * Pull the skill / unique_name from the user's message. Handles three shapes, in
 * priority order, so "cmc skill execute <name>" works without the `skill:` syntax:
 *   1. explicit tag    — "skill: daily_market_overview" / "unique_name=daily_market_overview"
 *   2. after a verb     — "execute/run/invoke [the] [skill] daily_market_overview"
 *   3. a bare unique_name — any standalone snake_case token (CMC names always have an `_`)
 * The params/parameters JSON is stripped first so snake_case keys inside it (e.g.
 * {"preview_mode": true}) aren't mistaken for the skill name. Returns undefined when no
 * concrete skill is named (the handler then lists, or falls back to a find_skill search).
 */
function parseSkill(text: string): string | undefined {
  const t = text.replace(/\b(?:params|parameters)\s*[:=]\s*\{[\s\S]*?\}/gi, ' ');
  const tagged = t.match(/\b(?:skill|unique_name)\s*[:=]\s*["']?([a-z][a-z0-9_]{3,})/i);
  if (tagged) return tagged[1].toLowerCase();
  const verb = t.match(
    /\b(?:execute|run|invoke)\s+(?:the\s+)?(?:skill\s+)?["']?([a-z][a-z0-9]*(?:_[a-z0-9]+)+)/i,
  );
  if (verb) return verb[1].toLowerCase();
  const bare = t.match(/\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/i)?.[1]?.toLowerCase();
  return bare && bare !== 'find_skill' && bare !== 'execute_skill' && bare !== 'unique_name'
    ? bare
    : undefined;
}

/**
 * True when the message asks to LIST/FIND the available skills rather than run one
 * (the legacy "cmc skill find" feature). Only when no concrete skill is named — if the
 * user names a skill, they want to execute it. Debug/probe phrasings are AGENT_DEBUG's.
 */
function wantsSkillList(text: string): boolean {
  const t = text.toLowerCase();
  if (/\b(execute|run|invoke)\b/.test(t)) return false;
  if (/\bcmc\s+skill\s+(find|list)\b/.test(t)) return true;
  return /\b(find|list|show|which|what|available)\b[\s\S]*\bskills?\b/.test(t);
}

/** The agent's CMC skill inventory grouped by feature bundle — deterministic, no API call. */
function buildSkillInventory(): string {
  const lines: string[] = ['**CMC Skill Hub — skills this agent uses**'];
  const all = new Set<string>();
  for (const b of SKILL_BUNDLES) {
    const list = skillList(b.envKey, b.defaults);
    list.forEach((s) => all.add(s));
    lines.push(`\n**${b.feature}** (${list.length}) — via \`${b.envKey}\``);
    for (const s of list) lines.push(`• ${s}`);
  }
  lines.push(`\n_${all.size} unique skills across ${SKILL_BUNDLES.length} bundles._`);
  lines.push('Run one with `cmc skill execute <unique_name>` (e.g. `cmc skill execute daily_market_overview`).');
  return lines.join('\n');
}

/** Pull a params/parameters JSON object from the message (e.g. params: {"preview": true}). */
function parseParams(text: string): Record<string, unknown> {
  const m = text.match(/\b(?:params|parameters)\s*[:=]\s*(\{[\s\S]*?\})/i);
  if (!m) return {};
  try {
    return JSON.parse(m[1]) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function extractUniqueName(foundText: string, skill?: string): string | undefined {
  if (skill && new RegExp(`\\b${skill}\\b`, 'i').test(foundText)) return skill;
  // find_skill returns the field as "uniqueName" (camelCase) in its candidates; older
  // payloads / docs use "unique_name". `unique_?name` with the /i flag matches BOTH
  // ("unique" + optional "_" + "name"/"Name"), so resolution doesn't depend on the casing.
  const m =
    foundText.match(/"unique_?name"\s*:\s*"([^"]+)"/i) ||
    foundText.match(/unique_?name['"]?\s*[:=]\s*['"]([^'"]+)/i);
  return m?.[1] ?? skill;
}

/**
 * CMC_SKILL — deterministic CoinMarketCap Skill Hub runner.
 *
 * Calls find_skill → execute_skill itself through the MCP service (no LLM
 * tool-selection guesswork), then asks the model to format the REAL returned
 * data per whatever output spec the user included in their message.
 */
export const cmcSkillAction: Action = {
  name: 'CMC_SKILL',
  similes: [
    'RUN_CMC_SKILL',
    'EXECUTE_SKILL',
    'CMC_SKILL_HUB',
    'DAILY_MARKET_OVERVIEW',
    'MARKET_OVERVIEW',
    'FIND_SKILL',
    'LIST_SKILLS',
    'CMC_SKILL_FIND',
  ],
  description:
    'List the agent\'s CoinMarketCap Skill Hub skills ("cmc skill find" / "list skills"), or run one end-to-end ("cmc skill execute <name>" — find_skill then execute_skill) and return its result. Use for ANY request to list, invoke, run, or execute a CMC skill or a market overview (e.g. daily_market_overview).',

  validate: async (_runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    const t = (message.content?.text ?? '').toLowerCase();
    // Run/execute a skill (incl. the legacy "cmc skill execute" verb, an explicit
    // "skill: <name>" tag, and any invoke/run/execute placed near the word "skill").
    const run = /(find_skill|execute_skill|skill hub|cmc skill|coinmarketcap skill|daily_market_overview|skill\s*[:=]|(?:invoke|run|execute)\b[\s\S]{0,30}?\bskill|market overview)/.test(t);
    // List the available skills ("cmc skill find" / "list skills"). Debug/probe/diagnose
    // phrasings are AGENT_DEBUG's job, so they're explicitly excluded here.
    const list =
      !/\b(debug|probe|diagnos)/.test(t) &&
      /\b(find|list|show|which|what|available)\b[\s\S]*\bskills?\b/.test(t);
    return run || list;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined,
    _options: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const text = message.content?.text ?? '';
    const skill = parseSkill(text);
    const params = parseParams(text);

    // LIST mode — "cmc skill find" / "list skills": show the agent's skill inventory.
    // Deterministic and free (no MCP call); only when the user didn't name a skill to run.
    if (!skill && wantsSkillList(text)) {
      const inventory = buildSkillInventory();
      await callback?.({ text: inventory, actions: ['CMC_SKILL'] });
      return {
        text: 'listed CMC skills',
        success: true,
        data: { actionName: 'CMC_SKILL', mode: 'list' },
      };
    }

    const mcp = runtime.getService(McpService.serviceType) as unknown as McpLike | null;
    if (!mcp) {
      await callback?.({ text: 'CMC Skill Hub MCP service is not available (is @elizaos/plugin-mcp loaded?).', error: true });
      return { text: 'MCP service unavailable', success: false };
    }

    try {
      // 1) find_skill — confirm the unique_name.
      logger.info({ skill }, 'CMC_SKILL: find_skill');
      const found = await mcp.callTool(SERVER, 'find_skill', { query: skill ?? text.slice(0, 200) });
      const foundText = contentToText(found);
      const uniqueName = extractUniqueName(foundText, skill);
      if (!uniqueName) {
        await callback?.({ text: `Could not resolve a skill from your request. find_skill returned:\n${foundText.slice(0, 800)}`, error: true });
        return { text: 'skill not resolved', success: false };
      }

      // 2) execute_skill — run it with the provided parameters.
      logger.info({ uniqueName, params }, 'CMC_SKILL: execute_skill');
      const exec = await mcp.callTool(SERVER, 'execute_skill', { unique_name: uniqueName, parameters: params });
      const dataText = contentToText(exec);
      if (exec.isError) {
        await callback?.({ text: `execute_skill error for ${uniqueName}:\n${dataText.slice(0, 1000)}`, error: true });
        return { text: 'execute_skill error', success: false, data: { uniqueName } };
      }

      // 3) Format the REAL data per whatever output spec the user gave.
      const prompt = `${text}

----- SKILL RESULT (skill: ${uniqueName}) -----
Use ONLY the data below. Do not invent or fabricate any values. If a requested field is absent, say so.

${dataText}
----- END SKILL RESULT -----

Now produce the final answer, following the OUTPUT FORMAT / formatting rules from the request exactly.`;

      const report = await runtime.useModel(ModelType.TEXT_LARGE, { prompt });

      await callback?.({ text: report, actions: ['CMC_SKILL'] });
      return {
        text: `Executed CMC skill ${uniqueName}`,
        success: true,
        values: { skill: uniqueName },
        data: { actionName: 'CMC_SKILL', uniqueName, params },
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error({ error: msg }, 'CMC_SKILL failed');
      await callback?.({ text: `CMC Skill Hub error: ${msg}`, error: true });
      return { text: 'CMC skill failed', success: false, error: error instanceof Error ? error : new Error(msg) };
    }
  },

  examples: [
    [
      { name: '{{name1}}', content: { text: 'cmc skill find' } },
      { name: 'Astraeus', content: { text: '**CMC Skill Hub — skills this agent uses** ...', actions: ['CMC_SKILL'] } },
    ],
    [
      { name: '{{name1}}', content: { text: 'cmc skill execute daily_market_overview' } },
      { name: 'Astraeus', content: { text: '**TL;DR** ...', actions: ['CMC_SKILL'] } },
    ],
    [
      { name: '{{name1}}', content: { text: 'Invoke the daily_market_overview skill with params {"preview": true}' } },
      { name: 'Astraeus', content: { text: '**TL;DR** ...', actions: ['CMC_SKILL'] } },
    ],
  ],
};

export default cmcSkillAction;
