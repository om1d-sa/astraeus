import { logger, type IAgentRuntime, type Project, type ProjectAgent } from '@elizaos/core';
import tradingPlugin from './plugin.ts';
import { character } from './character.ts';

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
  plugins: [tradingPlugin],
};

const project: Project = {
  agents: [projectAgent],
};

export { character } from './character.ts';

export default project;
