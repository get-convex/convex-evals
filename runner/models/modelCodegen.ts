/**
 * LLM code generation: builds prompts, calls provider APIs, parses responses.
 *
 * Uses the Vercel AI SDK as a unified interface across all
 * providers. When the "web_search" experiment is active, a Tavily-powered
 * search tool is made available to every model.
 */
import { stepCountIs, streamText, type LanguageModel, type LanguageModelUsage } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import MarkdownIt from "markdown-it";
import { readFileSync, existsSync } from "fs";
import {
  type ResolvedModel,
  OPENROUTER_BASE_URL,
  SYSTEM_PROMPT,
} from "./index.js";
import { getGuidelines } from "./guidelines.js";
import {
  webSearchTool,
  WEB_SEARCH_SYSTEM_SUPPLEMENT,
  MAX_TOOL_STEPS,
} from "./webSearch.js";
import { logInfo } from "../logging.js";

// ── Experiment helpers ────────────────────────────────────────────────

function isWebSearchEnabled(): boolean {
  const exp = process.env.EVALS_EXPERIMENT;
  return exp === "web_search" || exp === "web_search_no_guidelines";
}

// ── Guidelines helpers ────────────────────────────────────────────────

function getGuidelinesContent(): string {
  const customPath = process.env.CUSTOM_GUIDELINES_PATH;
  if (customPath && existsSync(customPath)) {
    return readFileSync(customPath, "utf-8");
  }
  const exp = process.env.EVALS_EXPERIMENT;
  if (exp === "no_guidelines" || exp === "web_search_no_guidelines") return "";
  return getGuidelines();
}

// ── AI SDK model construction ────────────────────────────────────────

function createLanguageModel(
  model: ResolvedModel,
  apiKey: string,
): LanguageModel {
  if (model.apiKind === "responses") {
    const openai = createOpenAI({ apiKey, baseURL: model.baseURL });
    return openai.responses(model.runnableName);
  }

  const openrouter = createOpenAICompatible({
    name: "openrouter",
    baseURL: model.baseURL,
    apiKey,
    transformRequestBody: (body: Record<string, unknown>) => ({
      ...body,
      reasoning: { effort: "medium" },
    }),
  });
  return openrouter.chatModel(model.runnableName);
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function getAtPath(
  obj: Record<string, unknown>,
  path: readonly string[],
): unknown {
  let current: unknown = obj;
  for (const key of path) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function extractCostFromRawUsage(raw: Record<string, unknown>): number | null {
  const candidatePaths: ReadonlyArray<readonly string[]> = [
    ["cost"],
    ["usage", "cost"],
    ["usage", "total_cost"],
    ["usage", "totalCost"],
    ["total_cost"],
    ["totalCost"],
    ["providerMetadata", "openrouter", "cost"],
    ["provider_metadata", "openrouter", "cost"],
    ["response", "usage", "cost"],
    ["data", "usage", "cost"],
  ];

  for (const path of candidatePaths) {
    const value = getAtPath(raw, path);
    const parsed = asFiniteNumber(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

type OpenRouterModelPricing = {
  prompt: number;
  completion: number;
  inputCacheRead?: number;
};

const pricingCache = new Map<string, OpenRouterModelPricing | null>();

async function fetchOpenRouterModelPricing(
  baseURL: string,
  modelName: string,
): Promise<OpenRouterModelPricing | null> {
  const cacheKey = `${baseURL}|${modelName}`;
  if (pricingCache.has(cacheKey)) return pricingCache.get(cacheKey) ?? null;

  try {
    const resp = await fetch(`${baseURL.replace(/\/$/, "")}/models`);
    if (!resp.ok) {
      pricingCache.set(cacheKey, null);
      return null;
    }
    const json = (await resp.json()) as {
      data?: Array<{
        id?: string;
        pricing?: {
          prompt?: string | number;
          completion?: string | number;
          input_cache_read?: string | number;
        };
      }>;
    };

    const model = json.data?.find((m) => m.id === modelName);
    const pricing = model?.pricing;
    if (!pricing) {
      pricingCache.set(cacheKey, null);
      return null;
    }

    const prompt = asFiniteNumber(pricing.prompt);
    const completion = asFiniteNumber(pricing.completion);
    const inputCacheRead = asFiniteNumber(pricing.input_cache_read);
    if (prompt === null || completion === null) {
      pricingCache.set(cacheKey, null);
      return null;
    }

    const parsed: OpenRouterModelPricing = {
      prompt,
      completion,
      ...(inputCacheRead !== null ? { inputCacheRead } : {}),
    };
    pricingCache.set(cacheKey, parsed);
    return parsed;
  } catch {
    pricingCache.set(cacheKey, null);
    return null;
  }
}

export function computeCostFromUsageAndPricing(
  usage: LanguageModelUsage,
  pricing: OpenRouterModelPricing,
): number | null {
  const inputTokens =
    typeof usage.inputTokens === "number" ? usage.inputTokens : null;
  const outputTokens =
    typeof usage.outputTokens === "number" ? usage.outputTokens : null;
  if (inputTokens === null || outputTokens === null) return null;

  const noCacheInput = usage.inputTokenDetails?.noCacheTokens;
  const cacheReadInput = usage.inputTokenDetails?.cacheReadTokens ?? 0;
  const cacheWriteInput = usage.inputTokenDetails?.cacheWriteTokens ?? 0;

  const noCacheTokens =
    typeof noCacheInput === "number"
      ? noCacheInput
      : Math.max(0, inputTokens - cacheReadInput - cacheWriteInput);

  const promptCostPerToken = pricing.prompt;
  const cacheReadCostPerToken = pricing.inputCacheRead ?? promptCostPerToken;
  const completionCostPerToken = pricing.completion;

  const inputCost =
    noCacheTokens * promptCostPerToken +
    cacheReadInput * cacheReadCostPerToken +
    cacheWriteInput * promptCostPerToken;
  const outputCost = outputTokens * completionCostPerToken;
  const totalCost = inputCost + outputCost;
  return Number.isFinite(totalCost) ? totalCost : null;
}

/**
 * Normalize usage from provider-specific shapes into the canonical format used
 * by evalScores. Today, scoring reads only `usage.raw.cost`.
 */
export function normalizeUsageForScoring(
  usage: LanguageModelUsage | undefined,
): LanguageModelUsage | undefined {
  if (!usage) return usage;
  const raw = usage.raw;
  if (!raw || typeof raw !== "object") return usage;

  const rawObj = raw as Record<string, unknown>;
  const cost = extractCostFromRawUsage(rawObj);
  if (cost === null) return usage;

  const existing = asFiniteNumber(rawObj.cost);
  if (existing !== null && existing === cost) return usage;

  return {
    ...usage,
    raw: {
      ...rawObj,
      cost,
    },
  };
}

export function attachTimeToFirstTokenUsage({
  usage,
  timeToFirstTokenMs,
}: {
  usage: LanguageModelUsage | undefined;
  timeToFirstTokenMs: number | undefined;
}): LanguageModelUsage | undefined {
  if (timeToFirstTokenMs === undefined) return usage;

  const raw =
    usage?.raw && typeof usage.raw === "object"
      ? (usage.raw as Record<string, unknown>)
      : {};

  return {
    inputTokens: usage?.inputTokens,
    inputTokenDetails: usage?.inputTokenDetails ?? {
      noCacheTokens: undefined,
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined,
    },
    outputTokens: usage?.outputTokens,
    outputTokenDetails: usage?.outputTokenDetails ?? {
      textTokens: undefined,
      reasoningTokens: undefined,
    },
    totalTokens: usage?.totalTokens,
    reasoningTokens: usage?.reasoningTokens,
    cachedInputTokens: usage?.cachedInputTokens,
    raw: {
      ...raw,
      timeToFirstTokenMs,
    },
  };
}

async function enrichUsageWithOpenRouterPricingFallback(
  usage: LanguageModelUsage | undefined,
  modelName: string,
  baseURL: string,
): Promise<LanguageModelUsage | undefined> {
  if (!usage) return usage;

  const normalized = normalizeUsageForScoring(usage);
  const raw =
    normalized?.raw && typeof normalized.raw === "object"
      ? (normalized.raw as Record<string, unknown>)
      : null;
  if (raw && asFiniteNumber(raw.cost) !== null) return normalized;

  const pricing = await fetchOpenRouterModelPricing(baseURL, modelName);
  if (!pricing || !normalized) return normalized;

  const fallbackCost = computeCostFromUsageAndPricing(normalized, pricing);
  if (fallbackCost === null) return normalized;

  return {
    ...normalized,
    raw: {
      ...(raw ?? {}),
      cost: fallbackCost,
      costEstimatedFromPricing: true,
    },
  };
}

// ── Token limit helpers ──────────────────────────────────────────────

// Re-export LanguageModelUsage so callers can import it from here without
// coupling directly to the ai package.
export type { LanguageModelUsage };

function getMaxOutputTokens(model: ResolvedModel): number {
  if (model.name.startsWith("deepseek/")) return 4096;
  if (model.name === "anthropic/claude-3.5-sonnet") return 8192;
  return 16384;
}

// ── Model class ───────────────────────────────────────────────────────

export class Model {
  private languageModel: LanguageModel;
  private resolved: ResolvedModel;

  constructor(apiKey: string, model: ResolvedModel) {
    this.resolved = model;
    this.languageModel = createLanguageModel(model, apiKey);
  }

  async generate(prompt: string): Promise<{
    files: Record<string, string>;
    usage?: LanguageModelUsage;
    rawResponse: string;
  }> {
    const userPrompt = renderPrompt(prompt);
    const useWebSearch = isWebSearchEnabled();

    const systemContent = useWebSearch
      ? `${SYSTEM_PROMPT}\n\n${WEB_SEARCH_SYSTEM_SUPPLEMENT}`
      : SYSTEM_PROMPT;

    const maxTokens = getMaxOutputTokens(this.resolved);

    const baseOptions = {
      model: this.languageModel,
      maxOutputTokens: maxTokens,
      maxRetries: 5,
    };

    const promptOptions = {
      system: systemContent,
      prompt: userPrompt,
    };

    const requestStartedAt = Date.now();
    let timeToFirstTokenMs: number | undefined;

    const options: Parameters<typeof streamText>[0] = {
      ...baseOptions,
      ...promptOptions,
      onChunk: ({ chunk }) => {
        if (timeToFirstTokenMs !== undefined) return;
        if (chunk.type !== "text-delta") return;
        if (chunk.text.length === 0) return;
        timeToFirstTokenMs = Date.now() - requestStartedAt;
      },
    };

    if (this.resolved.apiKind === "responses") {
      options.providerOptions = {
        openai: { reasoningEffort: "medium" },
      };
    }

    if (useWebSearch) {
      options.tools = { web_search: webSearchTool };
      options.stopWhen = stepCountIs(MAX_TOOL_STEPS);
      options.onStepFinish = ({ toolCalls }) => {
        if (toolCalls && toolCalls.length > 0) {
          logInfo(
            `  [web_search] Model made ${toolCalls.length} tool call(s)`,
          );
        }
      };
    }

    const result = streamText(options);

    const [text, usage] = await Promise.all([
      result.text,
      result.usage,
    ]);

    const usageWithTiming = attachTimeToFirstTokenUsage({
      usage,
      timeToFirstTokenMs,
    });

    const enrichedUsage = await enrichUsageWithOpenRouterPricingFallback(
      usageWithTiming,
      this.resolved.runnableName,
      this.resolved.baseURL,
    );

    return {
      files: parseMarkdownResponse(text),
      usage: enrichedUsage,
      rawResponse: text,
    };
  }
}

// ── Response parsing ──────────────────────────────────────────────────

export function parseMarkdownResponse(
  response: string,
): Record<string, string> {
  const md = new MarkdownIt();
  const tokens = md.parse(response, {});

  const files: Record<string, string> = {};
  let currentFile: string | null = null;
  let inFilesSection = false;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    if (token.type === "heading_open" && token.tag === "h1") {
      const titleToken = tokens[i + 1];
      if (titleToken?.content === "Files") {
        inFilesSection = true;
        continue;
      }
    }

    if (!inFilesSection) continue;

    if (token.type === "heading_open" && token.tag === "h2") {
      const titleToken = tokens[i + 1];
      currentFile = titleToken?.content?.trim() ?? null;
    } else if (token.type === "fence" && currentFile) {
      files[currentFile] = token.content.trim();
      currentFile = null;
    }
  }

  return files;
}

// ── Prompt rendering ──────────────────────────────────────────────────

const FILE_FORMAT_EXAMPLE = [
  "# Files",
  "## package.json",
  "```\n...\n```",
  "## tsconfig.json",
  "```\n...\n```",
  "## convex/schema.ts",
  "```\n...\n```",
].join("\n");

export function renderPrompt(taskDescription: string): string {
  const sections: string[] = [
    "Your task is to generate a Convex backend from a task description.",
  ];

  sections.push(
    `Output all files within an h1 Files section that has an h2 section for each necessary file for a Convex backend that implements the requested functionality.
For example, correct output looks like
${FILE_FORMAT_EXAMPLE}`,
  );

  sections.push(`# General Coding Standards
- Use 2 spaces for code indentation.
- Ensure your code is clear, efficient, concise, and innovative.
- Maintain a friendly and approachable tone in any comments or documentation.`);

  const guidelinesContent = getGuidelinesContent();
  if (guidelinesContent) {
    sections.push(guidelinesContent);
  }

  sections.push(`# File Structure
- You can write to \`package.json\`, \`tsconfig.json\`, and any files within the \`convex/\` folder. Only write additional files (e.g. \`src/\`) if explicitly requested by the task description. Do NOT add extra files that were not asked for.
- Do NOT write to the \`convex/_generated\` folder. You can assume that \`npx convex dev\` will populate this folder.
- It's VERY IMPORTANT to output files to the correct paths, as specified in the task description.
- Always start with \`package.json\` and \`tsconfig.json\` files.
- Use Convex version "^1.31.2".
- Use Typescript version "^5.7.3".`);

  sections.push(
    `Now, implement a Convex backend that satisfies the following task description:\n\`\`\`\n${taskDescription}\n\`\`\``,
  );

  return sections.join("\n\n") + "\n";
}

/** Render guidelines for release builds. */
export function buildReleaseRules(): string {
  return getGuidelines();
}
