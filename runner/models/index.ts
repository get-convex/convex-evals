/**
 * Model definitions and provider configuration.
 * This is the single source of truth for all supported AI models.
 */

export const OPENROUTER_API_KEY_VAR = "OPENROUTER_API_KEY";
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const DEFAULT_MAX_CONCURRENCY = parseInt(
  process.env.OPENROUTER_CONCURRENCY ?? "8",
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
  "anthropic/claude-3.7-sonnet",
  "anthropic/claude-sonnet-4",
  "anthropic/claude-sonnet-4.5",
  "anthropic/claude-sonnet-4.6",
  "anthropic/claude-haiku-4.5",
  "anthropic/claude-opus-4.5",
  "anthropic/claude-opus-4.6",
  "anthropic/claude-opus-4.7",
  "openai/o4-mini",
  "openai/gpt-4.1",
  "openai/gpt-5.1",
  "openai/gpt-5.2",
  "openai/gpt-5.4",
  "openai/gpt-5.5",
  "openai/gpt-5.4-mini",
  "openai/gpt-5.4-nano",
  "openai/gpt-5.3-codex",
  "openai/gpt-5.2-codex",
  "openai/gpt-5",
  "openai/gpt-5-mini",
  "openai/gpt-5-nano",
  "deepseek/deepseek-chat-v3",
  "deepseek/deepseek-v4-pro",
  "deepseek/deepseek-r1",
  "meta-llama/llama-4-maverick",
  "qwen/qwen3-235b-a22b",
  "qwen/qwen3.5-plus-02-15",
  "qwen/qwen3.5-397b-a17b",
  "z-ai/glm-5",
  "z-ai/glm-4.7",
  "moonshotai/kimi-k2-0905",
  "moonshotai/kimi-k2.5",
  "moonshotai/kimi-k2.6",
  "google/gemini-2.5-flash",
  "google/gemini-3-flash-preview",
  "google/gemini-3.1-flash-lite-preview",
  "google/gemini-2.5-pro",
  "google/gemini-3.1-pro-preview",
  "minimax/minimax-m2.5",
  "x-ai/grok-4",
  "x-ai/grok-3-mini-beta",
  "xiaomi/mimo-v2-pro",
];

export const MODEL_NAMES: Set<string> = new Set(ALL_MODELS);

export const SYSTEM_PROMPT =
  "You are convexbot, a highly advanced software engineer specialized in creating applications using Convex and TypeScript.";
