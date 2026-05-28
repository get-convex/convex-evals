import type { ResolvedModel } from "./index.js";
import { OPENROUTER_BASE_URL, resolveModelDefaults } from "./index.js";

const OPENROUTER_MODEL_SEARCH_URL =
  "https://openrouter.ai/api/frontend/models/find";

interface FrontendEndpointInfo {
  adapter_name?: string;
  model_variant_slug?: string;
  model_variant_permaslug?: string;
  provider_slug?: string;
  provider_info?: {
    adapterName?: string;
  };
}

interface FrontendModelInfo {
  slug?: string;
  name?: string;
  input_modalities?: string[];
  output_modalities?: string[];
  has_text_output?: boolean;
  endpoint?: FrontendEndpointInfo;
}

interface FrontendModelSearchResponse {
  data?: {
    models?: FrontendModelInfo[];
  };
}

interface OpenRouterModelCatalogEntry {
  id?: string;
  canonical_slug?: string;
  created?: number;
  architecture?: {
    output_modalities?: string[];
  };
}

interface OpenRouterModelCatalogResponse {
  data?: OpenRouterModelCatalogEntry[];
}

interface OpenRouterCatalogData {
  createdAtBySlug: Map<string, number>;
  outputModalitiesBySlug: Map<string, string[]>;
}

const OPENROUTER_PREFLIGHT_TIMEOUT_MS = 15_000;
const OPENROUTER_MODELS_URL = `${OPENROUTER_BASE_URL}/models`;
let openRouterCatalogPromise: Promise<OpenRouterCatalogData | null> | null = null;

function toUnixMs(timestamp: number): number {
  // OpenRouter currently returns Unix seconds. Keep ms in our DB.
  return timestamp < 1_000_000_000_000 ? timestamp * 1000 : timestamp;
}

async function getOpenRouterCatalog(): Promise<OpenRouterCatalogData | null> {
  if (openRouterCatalogPromise) {
    return openRouterCatalogPromise;
  }

  openRouterCatalogPromise = (async () => {
    const response = await fetch(OPENROUTER_MODELS_URL, {
      headers: {
        Accept: "application/json",
        "User-Agent": "convex-evals-ci/1.0",
      },
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as OpenRouterModelCatalogResponse;
    if (!Array.isArray(payload.data)) return null;

    const createdAtBySlug = new Map<string, number>();
    const outputModalitiesBySlug = new Map<string, string[]>();

    for (const entry of payload.data) {
      const slugs: string[] = [];
      if (typeof entry.id === "string") slugs.push(entry.id);
      if (typeof entry.canonical_slug === "string") slugs.push(entry.canonical_slug);

      if (typeof entry.created === "number") {
        const createdMs = toUnixMs(entry.created);
        for (const slug of slugs) createdAtBySlug.set(slug, createdMs);
      }

      const modalities = entry.architecture?.output_modalities;
      if (Array.isArray(modalities)) {
        for (const slug of slugs) outputModalitiesBySlug.set(slug, modalities);
      }
    }

    return { createdAtBySlug, outputModalitiesBySlug };
  })();

  return openRouterCatalogPromise;
}

function inferApiKind(
  modelName: string,
  endpoint: FrontendEndpointInfo | undefined,
): ResolvedModel["apiKind"] | undefined {
  const adapterName =
    endpoint?.adapter_name ?? endpoint?.provider_info?.adapterName;
  if (typeof adapterName === "string" && adapterName.includes("Responses")) {
    return "responses";
  }

  // Fallback heuristic for OpenAI codex slugs if adapter metadata is absent.
  if (modelName.startsWith("openai/") && modelName.includes("codex")) {
    return "responses";
  }

  return undefined;
}

export interface DiscoveredModelInfo {
  runnableName?: string;
  formattedName?: string;
  apiKind?: ResolvedModel["apiKind"];
  provider: string;
  openRouterFirstSeenAt?: number;
  inputModalities?: string[];
  outputModalities?: string[];
  hasTextOutput?: boolean;
}

export interface OpenRouterEvalCapabilities {
  inputModalities?: string[];
  outputModalities?: string[];
  hasTextOutput?: boolean;
}

export function getTextOutputEvalIncompatibilityReason(
  capabilities: OpenRouterEvalCapabilities,
): string | null {
  const { inputModalities, outputModalities, hasTextOutput } = capabilities;

  if (inputModalities && !inputModalities.includes("text")) {
    return `input modalities [${inputModalities.join(", ")}] do not include text`;
  }

  if (outputModalities) {
    const isTextOnlyOutput =
      outputModalities.length === 1 && outputModalities[0] === "text";
    if (!isTextOnlyOutput) {
      return `output modalities [${outputModalities.join(", ")}] are not text-only`;
    }
    return null;
  }

  if (hasTextOutput === false) return "model does not have text output";

  return null;
}

export async function discoverOpenRouterModel(
  modelName: string,
): Promise<DiscoveredModelInfo | null> {
  const url = `${OPENROUTER_MODEL_SEARCH_URL}?q=${encodeURIComponent(modelName)}`;
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "convex-evals-ci/1.0",
    },
  });

  if (!response.ok) {
    throw new Error(
      `Failed to discover OpenRouter model "${modelName}": ${response.status} ${response.statusText}`,
    );
  }

  const payload = (await response.json()) as FrontendModelSearchResponse;
  const models = payload.data?.models;
  if (!Array.isArray(models)) {
    throw new Error(
      `Unexpected OpenRouter discovery response for "${modelName}"`,
    );
  }

  const exactMatch = models.find((model) => model.slug === modelName);
  if (!exactMatch) return null;

  const formattedName =
    typeof exactMatch.name === "string" && exactMatch.name.trim().length > 0
      ? exactMatch.name.trim()
      : undefined;

  const provider =
    exactMatch.endpoint?.provider_slug ??
    (modelName.includes("/") ? modelName.split("/")[0] : "openrouter");
  const runnableName = exactMatch.endpoint?.model_variant_slug ?? undefined;
  const catalog = await getOpenRouterCatalog();
  const openRouterFirstSeenAt = catalog?.createdAtBySlug.get(modelName);
  const inputModalities = Array.isArray(exactMatch.input_modalities)
    ? exactMatch.input_modalities
    : undefined;
  const outputModalities =
    Array.isArray(exactMatch.output_modalities)
      ? exactMatch.output_modalities
      : catalog?.outputModalitiesBySlug.get(modelName);
  const hasTextOutput =
    typeof exactMatch.has_text_output === "boolean"
      ? exactMatch.has_text_output
      : undefined;

  return {
    runnableName,
    formattedName,
    apiKind: inferApiKind(modelName, exactMatch.endpoint),
    provider,
    openRouterFirstSeenAt,
    inputModalities,
    outputModalities,
    hasTextOutput,
  };
}

/**
 * Resolve a model name into a fully populated ResolvedModel by merging
 * OpenRouter discovery data with defaults. If discovery fails, returns
 * defaults only with `discovered: false`.
 */
export async function resolveModel(modelName: string): Promise<{
  model: ResolvedModel;
  discovered: boolean;
  provider: string;
  openRouterFirstSeenAt?: number;
  inputModalities?: string[];
  outputModalities?: string[];
  hasTextOutput?: boolean;
}> {
  const cursorModels: Record<
    string,
    { runnableName: string; formattedName: string }
  > = {
    "cursor/composer-2.5": {
      runnableName: "composer-2.5",
      formattedName: "Cursor Composer 2.5",
    },
    "cursor/composer-2": {
      runnableName: "composer-2",
      formattedName: "Cursor Composer 2",
    },
  };
  const cursorModel = cursorModels[modelName];
  if (cursorModel) {
    return {
      model: {
        ...resolveModelDefaults(modelName),
        runnableName: cursorModel.runnableName,
        formattedName: cursorModel.formattedName,
        baseURL: "cursor-sdk",
        apiKind: "cursor-sdk",
      },
      discovered: true,
      provider: "cursor",
    };
  }

  const claudeCodeModels: Record<
    string,
    { runnableName: string; formattedName: string }
  > = {
    "claude-code/opus-4.7": {
      runnableName: "claude-opus-4-7",
      formattedName: "Claude Code (Opus 4.7)",
    },
    "claude-code-convex/opus-4.7": {
      runnableName: "claude-opus-4-7",
      formattedName: "Claude Code + Convex Plugin (Opus 4.7)",
    },
  };
  const claudeCodeModel = claudeCodeModels[modelName];
  if (claudeCodeModel) {
    return {
      model: {
        ...resolveModelDefaults(modelName),
        runnableName: claudeCodeModel.runnableName,
        formattedName: claudeCodeModel.formattedName,
        baseURL: "claude-code",
        apiKind: "claude-code",
      },
      discovered: true,
      provider: "anthropic",
    };
  }

  const info = await discoverOpenRouterModel(modelName).catch(() => null);
  const defaults = resolveModelDefaults(modelName);
  return {
    model: {
      ...defaults,
      ...(info?.runnableName ? { runnableName: info.runnableName } : {}),
      ...(info?.formattedName ? { formattedName: info.formattedName } : {}),
      ...(info?.apiKind ? { apiKind: info.apiKind } : {}),
    },
    discovered: info !== null,
    provider: info?.provider ?? "openrouter",
    openRouterFirstSeenAt: info?.openRouterFirstSeenAt,
    inputModalities: info?.inputModalities,
    outputModalities: info?.outputModalities,
    hasTextOutput: info?.hasTextOutput,
  };
}

function formatOpenRouterError(
  status: number,
  statusText: string,
  body: string,
): string {
  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: string };
      message?: string;
    };
    const message = parsed.error?.message ?? parsed.message;
    if (typeof message === "string" && message.trim().length > 0) {
      return `${status} ${statusText}: ${message}`;
    }
  } catch {
    // Body may be non-JSON, fall through to plain text formatting.
  }

  const trimmed = body.trim();
  if (trimmed.length === 0) return `${status} ${statusText}`;
  return `${status} ${statusText}: ${trimmed.slice(0, 300)}`;
}

export async function preflightOpenRouterEndpoint(
  model: ResolvedModel,
  apiKey: string,
): Promise<void> {
  const baseUrl = model.baseURL.replace(/\/$/, "");
  const url =
    model.apiKind === "responses"
      ? `${baseUrl}/responses`
      : `${baseUrl}/chat/completions`;

  const body =
    model.apiKind === "responses"
      ? {
          model: model.runnableName,
          input: "ping",
          max_output_tokens: 16,
        }
      : {
          model: model.runnableName,
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1,
          temperature: 0,
        };

  const abortController = new AbortController();
  const timeout = setTimeout(
    () => abortController.abort(),
    OPENROUTER_PREFLIGHT_TIMEOUT_MS,
  );

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      signal: abortController.signal,
    });

    if (!response.ok) {
      const responseBody = await response.text();
      throw new Error(
        `OpenRouter preflight failed for "${model.name}" using "${model.runnableName}" at ${url}: ${formatOpenRouterError(
          response.status,
          response.statusText,
          responseBody,
        )}`,
      );
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(
        `OpenRouter preflight timed out for "${model.name}" using "${model.runnableName}" after ${OPENROUTER_PREFLIGHT_TIMEOUT_MS}ms`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
