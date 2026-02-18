/**
 * Model definitions and provider configuration.
 * This is the single source of truth for all supported AI models.
 */

export enum ModelProvider {
  OPENROUTER = "openrouter",
}

export type CIRunFrequency = "daily" | "weekly" | "monthly" | "never";

export interface ModelTemplate {
  name: string;
  formattedName: string;
  maxConcurrency: number;
  requiresChainOfThought: boolean;
  usesSystemPrompt: boolean;
  provider: ModelProvider;
  overrideProxy?: string;
  supportsTemperature: boolean;
  ciRunFrequency: CIRunFrequency;
  usesResponsesApi: boolean;
}

function envInt(key: string, fallback: number): number {
  const val = process.env[key];
  return val ? parseInt(val, 10) : fallback;
}

export const ALL_MODELS: ModelTemplate[] = [
  // Anthropic models (via OpenRouter)
  {
    name: "anthropic/claude-3.5-sonnet",
    formattedName: "Claude 3.5 Sonnet",
    maxConcurrency: envInt("OPENROUTER_CONCURRENCY", 8),
    requiresChainOfThought: true,
    usesSystemPrompt: true,
    provider: ModelProvider.OPENROUTER,
    supportsTemperature: true,
    ciRunFrequency: "monthly",
    usesResponsesApi: false,
  },
  {
    name: "anthropic/claude-3.7-sonnet",
    formattedName: "Claude 3.7 Sonnet",
    maxConcurrency: envInt("OPENROUTER_CONCURRENCY", 8),
    requiresChainOfThought: true,
    usesSystemPrompt: true,
    provider: ModelProvider.OPENROUTER,
    supportsTemperature: true,
    ciRunFrequency: "monthly",
    usesResponsesApi: false,
  },
  {
    name: "anthropic/claude-sonnet-4",
    formattedName: "Claude 4 Sonnet",
    maxConcurrency: envInt("OPENROUTER_CONCURRENCY", 8),
    requiresChainOfThought: true,
    usesSystemPrompt: true,
    provider: ModelProvider.OPENROUTER,
    supportsTemperature: true,
    ciRunFrequency: "monthly",
    usesResponsesApi: false,
  },
  {
    name: "anthropic/claude-sonnet-4.5",
    formattedName: "Claude 4.5 Sonnet",
    maxConcurrency: envInt("OPENROUTER_CONCURRENCY", 8),
    requiresChainOfThought: true,
    usesSystemPrompt: true,
    provider: ModelProvider.OPENROUTER,
    supportsTemperature: true,
    ciRunFrequency: "weekly",
    usesResponsesApi: false,
  },
  {
    name: "anthropic/claude-sonnet-4.6",
    formattedName: "Claude 4.6 Sonnet",
    maxConcurrency: envInt("OPENROUTER_CONCURRENCY", 8),
    requiresChainOfThought: true,
    usesSystemPrompt: true,
    provider: ModelProvider.OPENROUTER,
    supportsTemperature: true,
    ciRunFrequency: "daily",
    usesResponsesApi: false,
  },
  {
    name: "anthropic/claude-haiku-4.5",
    formattedName: "Claude 4.5 Haiku",
    maxConcurrency: envInt("OPENROUTER_CONCURRENCY", 8),
    requiresChainOfThought: true,
    usesSystemPrompt: true,
    provider: ModelProvider.OPENROUTER,
    supportsTemperature: true,
    ciRunFrequency: "daily",
    usesResponsesApi: false,
  },
  {
    name: "anthropic/claude-opus-4.5",
    formattedName: "Claude 4.5 Opus",
    maxConcurrency: envInt("OPENROUTER_CONCURRENCY", 8),
    requiresChainOfThought: true,
    usesSystemPrompt: true,
    provider: ModelProvider.OPENROUTER,
    supportsTemperature: true,
    ciRunFrequency: "weekly",
    usesResponsesApi: false,
  },
  {
    name: "anthropic/claude-opus-4.6",
    formattedName: "Claude 4.6 Opus",
    maxConcurrency: envInt("OPENROUTER_CONCURRENCY", 8),
    requiresChainOfThought: true,
    usesSystemPrompt: true,
    provider: ModelProvider.OPENROUTER,
    supportsTemperature: true,
    ciRunFrequency: "daily",
    usesResponsesApi: false,
  },
  // OpenAI models (non-codex via OpenRouter)
  {
    name: "openai/o4-mini",
    formattedName: "o4-mini",
    maxConcurrency: envInt("OPENROUTER_CONCURRENCY", 8),
    requiresChainOfThought: false,
    usesSystemPrompt: false,
    provider: ModelProvider.OPENROUTER,
    supportsTemperature: false,
    ciRunFrequency: "monthly",
    usesResponsesApi: false,
  },
  {
    name: "openai/gpt-4.1",
    formattedName: "GPT-4.1",
    maxConcurrency: envInt("OPENROUTER_CONCURRENCY", 8),
    requiresChainOfThought: true,
    usesSystemPrompt: true,
    provider: ModelProvider.OPENROUTER,
    supportsTemperature: true,
    ciRunFrequency: "monthly",
    usesResponsesApi: false,
  },
  {
    name: "openai/gpt-5.1",
    formattedName: "GPT-5.1",
    maxConcurrency: envInt("OPENROUTER_CONCURRENCY", 8),
    requiresChainOfThought: false,
    usesSystemPrompt: false,
    provider: ModelProvider.OPENROUTER,
    supportsTemperature: false,
    ciRunFrequency: "monthly",
    usesResponsesApi: false,
  },
  {
    name: "openai/gpt-5.2",
    formattedName: "GPT-5.2",
    maxConcurrency: envInt("OPENROUTER_CONCURRENCY", 8),
    requiresChainOfThought: false,
    usesSystemPrompt: false,
    provider: ModelProvider.OPENROUTER,
    supportsTemperature: false,
    ciRunFrequency: "weekly",
    usesResponsesApi: false,
  },
  {
    name: "openai/gpt-5.2-codex",
    formattedName: "GPT-5.2 Codex",
    maxConcurrency: envInt("OPENROUTER_CONCURRENCY", 8),
    requiresChainOfThought: false,
    usesSystemPrompt: false,
    provider: ModelProvider.OPENROUTER,
    supportsTemperature: false,
    ciRunFrequency: "daily",
    usesResponsesApi: true,
  },
  // NOTE: gpt-5.3-codex was announced Feb 5, 2026 but API access is not yet available
  // Uncomment when API access is enabled:
  // {
  //   name: "openai/gpt-5.3-codex",
  //   formattedName: "GPT-5.3 Codex",
  //   maxConcurrency: envInt("OPENROUTER_CONCURRENCY", 8),
  //   requiresChainOfThought: false,
  //   usesSystemPrompt: false,
  //   provider: ModelProvider.OPENROUTER,
  //   supportsTemperature: false,
  //   ciRunFrequency: "daily",
  //   usesResponsesApi: true,
  // },
  {
    name: "openai/gpt-5",
    formattedName: "GPT-5",
    maxConcurrency: envInt("OPENROUTER_CONCURRENCY", 8),
    requiresChainOfThought: false,
    usesSystemPrompt: false,
    provider: ModelProvider.OPENROUTER,
    supportsTemperature: false,
    ciRunFrequency: "weekly",
    usesResponsesApi: false,
  },
  {
    name: "openai/gpt-5-mini",
    formattedName: "GPT-5 mini",
    maxConcurrency: envInt("OPENROUTER_CONCURRENCY", 8),
    requiresChainOfThought: false,
    usesSystemPrompt: false,
    provider: ModelProvider.OPENROUTER,
    supportsTemperature: false,
    ciRunFrequency: "weekly",
    usesResponsesApi: false,
  },
  {
    name: "openai/gpt-5-nano",
    formattedName: "GPT-5 nano",
    maxConcurrency: envInt("OPENROUTER_CONCURRENCY", 8),
    requiresChainOfThought: false,
    usesSystemPrompt: false,
    provider: ModelProvider.OPENROUTER,
    supportsTemperature: false,
    ciRunFrequency: "weekly",
    usesResponsesApi: false,
  },
  // DeepSeek / Together models (via OpenRouter)
  {
    name: "deepseek/deepseek-chat-v3",
    formattedName: "DeepSeek V3",
    maxConcurrency: envInt("OPENROUTER_CONCURRENCY", 8),
    requiresChainOfThought: true,
    usesSystemPrompt: true,
    provider: ModelProvider.OPENROUTER,
    supportsTemperature: true,
    ciRunFrequency: "daily",
    usesResponsesApi: false,
  },
  {
    name: "deepseek/deepseek-r1",
    formattedName: "DeepSeek R1",
    maxConcurrency: envInt("OPENROUTER_CONCURRENCY", 8),
    requiresChainOfThought: false,
    usesSystemPrompt: false,
    provider: ModelProvider.OPENROUTER,
    supportsTemperature: false,
    ciRunFrequency: "daily",
    usesResponsesApi: false,
  },
  {
    name: "meta-llama/llama-4-maverick",
    formattedName: "Llama 4 Maverick",
    maxConcurrency: envInt("OPENROUTER_CONCURRENCY", 8),
    requiresChainOfThought: false,
    usesSystemPrompt: true,
    provider: ModelProvider.OPENROUTER,
    supportsTemperature: true,
    ciRunFrequency: "weekly",
    usesResponsesApi: false,
  },
  {
    name: "qwen/qwen3-235b-a22b",
    formattedName: "Qwen3 235B",
    maxConcurrency: envInt("OPENROUTER_CONCURRENCY", 8),
    requiresChainOfThought: false,
    usesSystemPrompt: true,
    provider: ModelProvider.OPENROUTER,
    supportsTemperature: true,
    ciRunFrequency: "daily",
    usesResponsesApi: false,
  },
  {
    name: "qwen/qwen3.5-plus-02-15",
    formattedName: "Qwen3.5 Plus",
    maxConcurrency: envInt("OPENROUTER_CONCURRENCY", 8),
    requiresChainOfThought: false,
    usesSystemPrompt: true,
    provider: ModelProvider.OPENROUTER,
    supportsTemperature: true,
    ciRunFrequency: "daily",
    usesResponsesApi: false,
  },
  // Z.AI (GLM) models – via OpenRouter
  {
    name: "z-ai/glm-5",
    formattedName: "GLM 5",
    maxConcurrency: envInt("OPENROUTER_CONCURRENCY", 8),
    requiresChainOfThought: false,
    usesSystemPrompt: true,
    provider: ModelProvider.OPENROUTER,
    supportsTemperature: true,
    ciRunFrequency: "daily",
    usesResponsesApi: false,
  },
  {
    name: "z-ai/glm-4.7",
    formattedName: "GLM 4.7",
    maxConcurrency: envInt("OPENROUTER_CONCURRENCY", 8),
    requiresChainOfThought: false,
    usesSystemPrompt: true,
    provider: ModelProvider.OPENROUTER,
    supportsTemperature: true,
    ciRunFrequency: "weekly",
    usesResponsesApi: false,
  },
  // Moonshot AI (Kimi) models – via OpenRouter
  {
    name: "moonshotai/kimi-k2-0905",
    formattedName: "Kimi K2",
    maxConcurrency: envInt("OPENROUTER_CONCURRENCY", 8),
    requiresChainOfThought: false,
    usesSystemPrompt: true,
    provider: ModelProvider.OPENROUTER,
    supportsTemperature: true,
    ciRunFrequency: "weekly",
    usesResponsesApi: false,
  },
  {
    name: "moonshotai/kimi-k2.5",
    formattedName: "Kimi K2.5",
    maxConcurrency: envInt("OPENROUTER_CONCURRENCY", 8),
    requiresChainOfThought: false,
    usesSystemPrompt: true,
    provider: ModelProvider.OPENROUTER,
    supportsTemperature: false,
    ciRunFrequency: "daily",
    usesResponsesApi: false,
  },
  // MiniMax models – via OpenRouter
  {
    name: "minimax/minimax-m2.5",
    formattedName: "MiniMax M2.5",
    maxConcurrency: envInt("OPENROUTER_CONCURRENCY", 8),
    requiresChainOfThought: false,
    usesSystemPrompt: true,
    provider: ModelProvider.OPENROUTER,
    supportsTemperature: false,
    ciRunFrequency: "daily",
    usesResponsesApi: false,
  },
  // Google models – via OpenRouter
  {
    name: "google/gemini-2.5-flash",
    formattedName: "Gemini 2.5 Flash",
    maxConcurrency: envInt("OPENROUTER_CONCURRENCY", 8),
    requiresChainOfThought: true,
    usesSystemPrompt: false,
    provider: ModelProvider.OPENROUTER,
    supportsTemperature: true,
    ciRunFrequency: "daily",
    usesResponsesApi: false,
  },
  {
    name: "google/gemini-2.5-pro",
    formattedName: "Gemini 2.5 Pro",
    maxConcurrency: envInt("OPENROUTER_CONCURRENCY", 8),
    requiresChainOfThought: false,
    usesSystemPrompt: false,
    provider: ModelProvider.OPENROUTER,
    supportsTemperature: true,
    ciRunFrequency: "weekly",
    usesResponsesApi: false,
  },
  {
    name: "google/gemini-3-pro-preview",
    formattedName: "Gemini 3 Pro",
    maxConcurrency: envInt("OPENROUTER_CONCURRENCY", 8),
    requiresChainOfThought: false,
    usesSystemPrompt: false,
    provider: ModelProvider.OPENROUTER,
    supportsTemperature: true,
    ciRunFrequency: "daily",
    usesResponsesApi: false,
  },
  // xAI models – via OpenRouter
  {
    name: "x-ai/grok-4",
    formattedName: "Grok 4",
    maxConcurrency: envInt("OPENROUTER_CONCURRENCY", 8),
    requiresChainOfThought: false,
    usesSystemPrompt: false,
    provider: ModelProvider.OPENROUTER,
    supportsTemperature: true,
    ciRunFrequency: "daily",
    usesResponsesApi: false,
  },
  {
    name: "x-ai/grok-3-mini-beta",
    formattedName: "Grok 3 Mini (Beta)",
    maxConcurrency: envInt("OPENROUTER_CONCURRENCY", 8),
    requiresChainOfThought: false,
    usesSystemPrompt: false,
    provider: ModelProvider.OPENROUTER,
    supportsTemperature: true,
    ciRunFrequency: "weekly",
    usesResponsesApi: false,
  },
];

export const MODELS_BY_NAME: Record<string, ModelTemplate> = Object.fromEntries(
  ALL_MODELS.map((m) => [m.name, m]),
);

export const SYSTEM_PROMPT =
  "You are convexbot, a highly advanced software engineer specialized in creating applications using Convex and TypeScript.";

/** Map provider enum to the environment variable key for its API key. */
export function getApiKeyEnvVar(provider: ModelProvider): string {
  const map: Record<ModelProvider, string> = {
    [ModelProvider.OPENROUTER]: "OPENROUTER_API_KEY",
  };
  return map[provider];
}

/** Get the direct API base URL for a provider (no proxy). */
export function getProviderBaseUrl(provider: ModelProvider): string {
  const map: Record<ModelProvider, string> = {
    [ModelProvider.OPENROUTER]: "https://openrouter.ai/api/v1",
  };
  return map[provider];
}
