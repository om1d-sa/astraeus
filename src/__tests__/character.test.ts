import { describe, expect, it } from 'bun:test';
import project, { character } from '../index';

describe('Character Configuration', () => {
  it('should have all required fields', () => {
    expect(character).toHaveProperty('name');
    expect(character).toHaveProperty('bio');
    expect(character).toHaveProperty('plugins');
    expect(character).toHaveProperty('system');
    expect(character).toHaveProperty('messageExamples');
  });

  it('should have the correct name', () => {
    expect(typeof character.name).toBe('string');
    expect(character.name.length).toBeGreaterThan(0);
  });

  it('should have plugins defined as an array', () => {
    expect(Array.isArray(character.plugins)).toBe(true);
  });

  it('should have conditionally included plugins based on environment variables', () => {
    // This test is a simple placeholder since we can't easily test dynamic imports in test environments
    // The actual functionality is tested at runtime by the starter test suite

    // Save the original env values
    const originalOpenAIKey = process.env.OPENAI_API_KEY;
    const originalAnthropicKey = process.env.ANTHROPIC_API_KEY;

    try {
      // Core plugins are always present.
      expect(character.plugins).toContain('@elizaos/plugin-sql');
      expect(character.plugins).toContain('@elizaos/plugin-bootstrap');
      // Astraeus uses OpenRouter as its model provider (LLM + embeddings).
      expect(character.plugins).toContain('@elizaos/plugin-openrouter');

      // The MCP plugin is NOT in character.plugins anymore — it's registered SERVICE-ONLY
      // in projectAgent.plugins (index.ts) so its LLM-facing CALL_MCP_TOOL action can be
      // stripped. character.plugins should never contain it.
      expect(character.plugins).not.toContain('@elizaos/plugin-mcp');

      // When CMC/TWAK creds are configured, the service-only MCP plugin object IS added to
      // the project agent: McpService present, but no CALL_MCP_TOOL / READ_MCP_RESOURCE.
      if (process.env.COINMARKETCAP_API_KEY || process.env.TWAK_ACCESS_ID) {
        const agentPlugins = project.agents[0].plugins ?? [];
        const mcp = agentPlugins.find((p) => p?.name === 'mcp');
        expect(mcp).toBeDefined();
        expect((mcp?.actions ?? []).length).toBe(0);
        expect((mcp?.services ?? []).length).toBeGreaterThan(0);
      }
    } finally {
      // Restore original env values
      process.env.OPENAI_API_KEY = originalOpenAIKey;
      process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
    }
  });

  it('should have a non-empty system prompt', () => {
    expect(character.system).toBeTruthy();
    if (character.system) {
      expect(typeof character.system).toBe('string');
      expect(character.system.length).toBeGreaterThan(0);
    }
  });

  it('should have personality traits in bio array', () => {
    expect(Array.isArray(character.bio)).toBe(true);
    if (character.bio && Array.isArray(character.bio)) {
      expect(character.bio.length).toBeGreaterThan(0);
      // Check if bio entries are non-empty strings
      character.bio.forEach((trait) => {
        expect(typeof trait).toBe('string');
        expect(trait.length).toBeGreaterThan(0);
      });
    }
  });

  it('should expose messageExamples as an array', () => {
    // Astraeus routes behavior through the system prompt + action examples rather
    // than character-level messageExamples, so this array is intentionally empty.
    expect(Array.isArray(character.messageExamples)).toBe(true);

    // If examples are present, each turn must have a name and content.text.
    for (const example of character.messageExamples ?? []) {
      expect(Array.isArray(example)).toBe(true);
      for (const message of example) {
        expect(message).toHaveProperty('name');
        expect(message).toHaveProperty('content');
        expect(message.content).toHaveProperty('text');
      }
    }
  });
});
