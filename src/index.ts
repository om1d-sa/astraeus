import { logger, type IAgentRuntime, type Plugin, type Project, type ProjectAgent } from '@elizaos/core';
import mcpPlugin from '@elizaos/plugin-mcp';
import tradingPlugin from './plugin.ts';
import { character } from './character.ts';

/**
 * MCP wired SERVICE-ONLY: keep the McpService (our actions call it via
 * runtime.getService — CMC_SKILL, AGENT_DEBUG, the skill bundles) but strip the plugin's
 * LLM-facing actions (CALL_MCP_TOOL, READ_MCP_RESOURCE) and its tool-listing provider.
 * Otherwise the model picks CALL_MCP_TOOL for "debug skill bundles", runs a find_skill
 * search, and FABRICATES a probe report instead of running AGENT_DEBUG. TWAK execution is
 * unaffected — it shells out to the `twak` CLI, not MCP.
 */
const mcpServiceOnly: Plugin = { ...(mcpPlugin as Plugin), actions: [], providers: [] };
const mcpEnabled =
  !!process.env.COINMARKETCAP_API_KEY?.trim() || !!process.env.TWAK_ACCESS_ID?.trim();

/**
 * Validate required environment before the agent starts.
 * Warnings (not errors) so the agent can still boot for chat/dev while
 * execution credentials are being set up.
 */
function validateEnvironment(): void {
  if (!process.env.OPENROUTER_API_KEY) {
    logger.warn('OPENROUTER_API_KEY is not set — the agent cannot call its LLM until this is configured.');
  }
}

const initCharacter = (_runtime: IAgentRuntime) => {
  logger.info({ name: character.name }, 'Initializing agent');
  validateEnvironment();
  logger.info({ plugins: character.plugins }, 'Character plugins');
};

export const projectAgent: ProjectAgent = {
  character,
  init: async (runtime: IAgentRuntime) => initCharacter(runtime),
  plugins: [tradingPlugin, ...(mcpEnabled ? [mcpServiceOnly] : [])],
};

const project: Project = {
  agents: [projectAgent],
};

export { character } from './character.ts';

export default project;
