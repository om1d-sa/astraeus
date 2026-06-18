/**
 * Centralized Model Configuration
 * All model references should import from here to avoid duplication.
 * The source of truth is character.ts - this file extracts those values.
 */

import { character } from "../character";

// Type for model settings (ElizaOS doesn't export this properly)
interface ModelSettings {
  small?: string;
  medium?: string;
  large?: string;
  embedding?: string;
}

// Extract model IDs from character settings (remove "openrouter:" prefix for direct API calls)
const extractModelId = (model: string): string => {
  return model.replace("openrouter:", "");
};

// Get models from character settings with proper typing
const models = (character.settings?.models || {}) as ModelSettings;
const embeddingModel = character.settings?.embeddingModel as string | undefined;
const defaultModel = character.settings?.model as string | undefined;

// Model configuration - single source of truth derived from character.ts
export const MODELS = {
  // For search tasks (small/fast)
  search: extractModelId(models.small || "google/gemini-3-pro-preview"),

  // For reasoning and text generation (medium)
  reasoning: extractModelId(models.medium || "openai/gpt-5.2-pro"),

  // For forecast, predict, calculate tasks (large)
  forecast: extractModelId(models.large || "anthropic/claude-opus-4.5"),

  // For embeddings
  embedding: extractModelId(embeddingModel || "openai/text-embedding-3-large"),

  // Default model (same as forecast/large)
  default: extractModelId(defaultModel || "anthropic/claude-opus-4.5"),
} as const;

// OpenRouter API configuration
export const OPENROUTER_CONFIG = {
  baseUrl: "https://openrouter.ai/api/v1",
  chatEndpoint: "https://openrouter.ai/api/v1/chat/completions",
} as const;

/**
 * Get headers for OpenRouter API calls
 */
export function getOpenRouterHeaders(): Record<string, string> {
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY environment variable is required");
  }

  return {
    Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
    "Content-Type": "application/json",
  };
}

// Export for reference
export type ModelType = keyof typeof MODELS;
