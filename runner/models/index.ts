/**
 * Model definitions and provider configuration.
 * This is the single source of truth for all supported AI models.
 */

export const OPENROUTER_API_KEY_VAR = "OPENROUTER_API_KEY";
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const DEFAULT_MAX_CONCURRENCY = parseInt(
  process.env.OPENROUTER_CONCURRENCY ?? "4",
  10,
);

export interface ResolvedModel {
  name: string;
  runnableName: string;
  formattedName: string;
  baseURL: string;
  apiKind: "chat" | "responses";
}

export function resolveModelDefaults(name: string): ResolvedModel {
  return {
    name,
    runnableName: name,
    formattedName: name,
    baseURL: OPENROUTER_BASE_URL,
    apiKind: "chat",
  };
}

export const ALL_MODELS: string[] = [
  "anthropic/claude-sonnet-5.5",
  "anthropic/claude-sonnet-5",
  "anthropic/claude-opus-5",
  "anthropic/claude-opus-4.8",
  "anthropic/claude-fable-5",
  "openai/gpt-5.5",
  "openai/gpt-5.6-sol",
  "openai/gpt-5.6-terra",
  "openai/gpt-5.6-luna",
  "openai/gpt-6-astra",
  "openai/gpt-6.1-sol",
  "deepseek/deepseek-v4-pro",
  "z-ai/glm-5.3-flash",
  "poolside/laguna-s-2.1",
  "moonshotai/kimi-k3",
  "x-ai/grok-4.6",
  "x-ai/grok-4.5",
];

export const MODEL_NAMES: Set<string> = new Set(ALL_MODELS);

// These models' no_guidelines_with_web runs aborted twice in the 2026-09-16
// client-web batch (request timeouts in the tool loop, or Gemini's corrupted
// thought signature). The periodic schedule skips only their web condition.
// Remove an entry to let the schedule retry it.
export const PERIODIC_WEB_EXCLUDED_MODELS: string[] = [
  "deepseek/deepseek-v4-pro-0813",
  "google/gemini-3.8-flash",
  "tencent/hy3",
  "tencent/hy4-preview",
  "upstage/solar-pro4",
];

export const SYSTEM_PROMPT =
  "You are convexbot, a highly advanced software engineer specialized in creating applications using Convex and TypeScript.";
