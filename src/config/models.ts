/**
 * Forecast-predictor model config.
 *
 * The source of truth for ALL models is character.ts. This module exists ONLY for
 * the forecast predictor (predictor.ts), which calls the OpenRouter API DIRECTLY
 * (outside the ElizaOS plugin tiers) and so needs a plain model id.
 *
 * Every OTHER model path — SMALL / LARGE / EMBEDDING — is handled by the
 * @elizaos/plugin-openrouter runtime via character.settings (OPENROUTER_*_MODEL),
 * NOT here. That's why this file exposes only `reasoning`: the medium tier the
 * predictor consumes. (It previously also defined search / forecast / embedding /
 * default entries, but nothing read them and names like `forecast` were misleading
 * — the forecast path actually uses `reasoning`. Dropped to avoid the footgun.)
 */

import { character } from "../character";

interface ModelSettings {
  medium?: string;
}

// Strip the "openrouter:" prefix — the predictor hits the OpenRouter API directly.
const extractModelId = (model: string): string => model.replace("openrouter:", "");

const models = (character.settings?.models || {}) as ModelSettings;

// The only model this module exposes: the forecast predictor's reasoning model,
// derived from settings.models.medium (MEDIUM_MODEL in character.ts). The fallback
// only fires if character.settings.models is empty (it never is).
export const MODELS = {
  reasoning: extractModelId(models.medium || "anthropic/claude-sonnet-4.6"),
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
