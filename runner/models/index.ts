/**
 * Model definitions and provider configuration.
 * This is the single source of truth for all supported AI models.
 */

export type CIRunFrequency = "daily" | "weekly" | "monthly" | "never";

export const OPENROUTER_API_KEY_VAR = "OPENROUTER_API_KEY";
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const DEFAULT_MAX_CONCURRENCY = parseInt(
  process.env.OPENROUTER_CONCURRENCY ?? "8",
  10,
);

export interface ModelTemplate {
  name: string;
  formattedName: string;
  overrideProxy?: string;
  ciRunFrequency: CIRunFrequency;
  apiKind?: "chat" | "responses";
}

export const ALL_MODELS: ModelTemplate[] = [
  // Anthropic models (via OpenRouter)
  {
    name: "anthropic/claude-3.5-sonnet",
    formattedName: "Claude 3.5 Sonnet",
    ciRunFrequency: "monthly",
  },
  {
    name: "anthropic/claude-3.7-sonnet",
    formattedName: "Claude 3.7 Sonnet",
    ciRunFrequency: "monthly",
  },
  {
    name: "anthropic/claude-sonnet-4",
    formattedName: "Claude 4 Sonnet",
    ciRunFrequency: "monthly",
  },
  {
    name: "anthropic/claude-sonnet-4.5",
    formattedName: "Claude 4.5 Sonnet",
    ciRunFrequency: "weekly",
  },
  {
    name: "anthropic/claude-sonnet-4.6",
    formattedName: "Claude 4.6 Sonnet",
    ciRunFrequency: "daily",
  },
  {
    name: "anthropic/claude-haiku-4.5",
    formattedName: "Claude 4.5 Haiku",
    ciRunFrequency: "daily",
  },
  {
    name: "anthropic/claude-opus-4.5",
    formattedName: "Claude 4.5 Opus",
    ciRunFrequency: "weekly",
  },
  {
    name: "anthropic/claude-opus-4.6",
    formattedName: "Claude 4.6 Opus",
    ciRunFrequency: "daily",
  },
  // OpenAI models (non-codex via OpenRouter)
  {
    name: "openai/o4-mini",
    formattedName: "o4-mini",
    ciRunFrequency: "monthly",
  },
  {
    name: "openai/gpt-4.1",
    formattedName: "GPT-4.1",
    ciRunFrequency: "monthly",
  },
  {
    name: "openai/gpt-5.1",
    formattedName: "GPT-5.1",
    ciRunFrequency: "monthly",
  },
  {
    name: "openai/gpt-5.2",
    formattedName: "GPT-5.2",
    ciRunFrequency: "weekly",
  },
  {
    name: "openai/gpt-5.2-codex",
    formattedName: "GPT-5.2 Codex",
    ciRunFrequency: "daily",
    apiKind: "responses",
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
  //   apiKind: "responses",
  // },
  {
    name: "openai/gpt-5",
    formattedName: "GPT-5",
    ciRunFrequency: "weekly",
  },
  {
    name: "openai/gpt-5-mini",
    formattedName: "GPT-5 mini",
    ciRunFrequency: "weekly",
  },
  {
    name: "openai/gpt-5-nano",
    formattedName: "GPT-5 nano",
    ciRunFrequency: "weekly",
  },
  // DeepSeek / Together models (via OpenRouter)
  {
    name: "deepseek/deepseek-chat-v3",
    formattedName: "DeepSeek V3",
    ciRunFrequency: "daily",
  },
  {
    name: "deepseek/deepseek-r1",
    formattedName: "DeepSeek R1",
    ciRunFrequency: "daily",
  },
  {
    name: "meta-llama/llama-4-maverick",
    formattedName: "Llama 4 Maverick",
    ciRunFrequency: "weekly",
  },
  {
    name: "qwen/qwen3-235b-a22b",
    formattedName: "Qwen3 235B",
    ciRunFrequency: "daily",
  },
  {
    name: "qwen/qwen3.5-plus-02-15",
    formattedName: "Qwen3.5 Plus",
    ciRunFrequency: "daily",
  },
  // Z.AI (GLM) models – via OpenRouter
  {
    name: "z-ai/glm-5",
    formattedName: "GLM 5",
    ciRunFrequency: "daily",
  },
  {
    name: "z-ai/glm-4.7",
    formattedName: "GLM 4.7",
    ciRunFrequency: "weekly",
  },
  // Moonshot AI (Kimi) models – via OpenRouter
  {
    name: "moonshotai/kimi-k2-0905",
    formattedName: "Kimi K2",
    ciRunFrequency: "weekly",
  },
  {
    name: "moonshotai/kimi-k2.5",
    formattedName: "Kimi K2.5",
    ciRunFrequency: "daily",
  },
  // Google models – via OpenRouter
  {
    name: "google/gemini-2.5-flash",
    formattedName: "Gemini 2.5 Flash",
    ciRunFrequency: "weekly",
  },
  {
    name: "google/gemini-2.5-pro",
    formattedName: "Gemini 2.5 Pro",
    ciRunFrequency: "weekly",
  },
  {
    name: "google/gemini-3-flash-preview",
    formattedName: "Gemini 3 Flash",
    ciRunFrequency: "daily",
  },
  {
    name: "google/gemini-3-pro-preview",
    formattedName: "Gemini 3 Pro",
    ciRunFrequency: "daily",
  },
  // MiniMax models – via OpenRouter
  {
    name: "minimax/minimax-m2.5",
    formattedName: "MiniMax M2.5",
    ciRunFrequency: "daily",
  },
  // xAI models – via OpenRouter
  {
    name: "x-ai/grok-4",
    formattedName: "Grok 4",
    ciRunFrequency: "daily",
  },
  {
    name: "x-ai/grok-3-mini-beta",
    formattedName: "Grok 3 Mini (Beta)",
    ciRunFrequency: "weekly",
  },
];

export const MODELS_BY_NAME: Record<string, ModelTemplate> = Object.fromEntries(
  ALL_MODELS.map((m) => [m.name, m]),
);

export const SYSTEM_PROMPT =
  "You are convexbot, a highly advanced software engineer specialized in creating applications using Convex and TypeScript.";

