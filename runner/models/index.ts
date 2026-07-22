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
  apiKind: "chat" | "responses" | "cursor-sdk";
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
  "cursor/composer-2.5",
  "anthropic/claude-sonnet-5",
  "anthropic/claude-opus-4.8",
  "anthropic/claude-fable-5",
  "openai/gpt-5.5",
  "openai/gpt-5.6-sol",
  "openai/gpt-5.6-terra",
  "openai/gpt-5.6-luna",
  "deepseek/deepseek-v4-pro",
  "poolside/laguna-s-2.1",
  "moonshotai/kimi-k3",
  "x-ai/grok-4.5",
];

export const MODEL_NAMES: Set<string> = new Set(ALL_MODELS);

export const SYSTEM_PROMPT =
  "You are convexbot, a highly advanced software engineer specialized in creating applications using Convex and TypeScript.";
