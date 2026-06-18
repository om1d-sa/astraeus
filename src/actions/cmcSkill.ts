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

/** Pull the skill / unique_name from the user's message (e.g. "skill: daily_market_overview"). */
function parseSkill(text: string): string | undefined {
  const m = text.match(/\b(?:skill|unique_name)\s*[:=]\s*["']?([a-z][a-z0-9_]{3,})/i);
  return m?.[1];
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
  const m =
    foundText.match(/"unique_name"\s*:\s*"([^"]+)"/i) ||
    foundText.match(/unique_name['"]?\s*[:=]\s*['"]([^'"]+)/i);
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
  ],
  description:
    'Run a CoinMarketCap Skill Hub skill end-to-end (find_skill then execute_skill) and return its result. Use for ANY request to invoke / run / execute a CMC skill or a market overview (e.g. daily_market_overview).',

  validate: async (_runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    const t = (message.content?.text ?? '').toLowerCase();
    return /(find_skill|execute_skill|skill hub|cmc skill|coinmarketcap skill|daily_market_overview|invoke a .*skill|run .*skill|execute .*skill|market overview)/.test(t);
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
      { name: '{{name1}}', content: { text: 'Invoke the daily_market_overview skill with params {"preview": true}' } },
      { name: 'Astraeus', content: { text: '**TL;DR** ...', actions: ['CMC_SKILL'] } },
    ],
  ],
};

export default cmcSkillAction;
