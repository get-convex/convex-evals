import { streamText, type LanguageModel, type LanguageModelUsage } from "ai";
import {
  EventSourceParserStream,
  type FetchFunction,
} from "@ai-sdk/provider-utils";
import { mkdirSync, writeFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { InfrastructureError } from "../convexBackend.js";
import { OPENROUTER_BASE_URL } from "./index.js";
import {
  WEB_RESEARCH_LIMITS,
  withWebResearchTools,
} from "./webResearchTools.js";

type JsonObject = Record<string, unknown>;
type RequestTrace = {
  startedAt: string;
  request: JsonObject;
  httpStatus?: number;
  events: unknown[];
};

export type WebResearchTrace = {
  version: 2;
  experiment: "no_guidelines_with_web";
  model: string;
  provider: "openrouter";
  searchEngine: "exa";
  fetchEngine: "exa";
  requestProfile: "exa-v1";
  apiKind: "chat" | "responses";
  startedAt: string;
  completedAt?: string;
  status: "running" | "completed" | "failed";
  system: string;
  prompt: string;
  limits: typeof WEB_RESEARCH_LIMITS & {
    maxOutputTokens: number;
    modelRetries: number;
  };
  // Preserve provider-visible events. Chat generally exposes citations and
  // counters; Responses can also expose completed search/fetch items.
  requests: RequestTrace[];
  citations: unknown[];
  serverToolItems: JsonObject[];
  routerMetadata?: unknown;
  partialText: string;
  usage?: LanguageModelUsage;
  summary?: {
    searchRequests: number | null;
    fetchRequests: number | null;
    toolCallsRequested: number | null;
    toolCallsExecuted: number | null;
    observedSearchItems: number;
    observedFetchItems: number;
    sourceCitations: number;
    requestAttempts: number;
    coverage: "provider-visible-only";
  };
  error?: string;
};

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

export function saveWebResearchTrace(
  path: string | undefined,
  trace: WebResearchTrace,
  apiKey?: string,
): void {
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  const json = JSON.stringify(trace, null, 2);
  writeFileSync(
    path + ".tmp",
    apiKey ? json.replaceAll(apiKey, "[redacted]") : json,
    {
      mode: 0o600,
    },
  );
  renameSync(path + ".tmp", path);
}

function isWebItem(value: unknown): boolean {
  const type = object(value)?.type;
  return type === "openrouter:web_search" || type === "openrouter:web_fetch";
}

/**
 * OpenRouter's Responses items are not in the installed OpenAI SDK's schema.
 * Capture them first, then omit only those items from the SDK's parsing view.
 * This changes neither the request nor anything the evaluated model receives.
 */
export function sdkResponseEvent(event: JsonObject): JsonObject | null {
  if (isWebItem(event.item)) return null;
  const response = object(event.response);
  if (response && Array.isArray(response.output)) {
    return {
      ...event,
      response: {
        ...response,
        output: response.output.filter((item) => !isWebItem(item)),
      },
    };
  }
  return event;
}

export async function generateWithWebResearch({
  createModel,
  modelName,
  system,
  prompt,
  maxOutputTokens,
  apiKey,
  sessionId,
  tracePath,
  responsesApi = false,
  fetch: fetchImpl = globalThis.fetch,
}: {
  createModel: (fetch: FetchFunction) => LanguageModel;
  modelName: string;
  system: string;
  prompt: string;
  maxOutputTokens: number;
  apiKey: string;
  sessionId?: string;
  tracePath?: string;
  responsesApi?: boolean;
  fetch?: FetchFunction;
}): Promise<{
  text: string;
  usage: LanguageModelUsage;
  trace: WebResearchTrace;
  timeToFirstTokenMs?: number;
  response: Awaited<ReturnType<typeof streamText>["response"]>;
}> {
  const startedAt = Date.now();
  const abort = new AbortController();
  const signal = AbortSignal.any([
    abort.signal,
    AbortSignal.timeout(WEB_RESEARCH_LIMITS.totalTimeoutMs),
  ]);
  const trace: WebResearchTrace = {
    version: 2,
    experiment: "no_guidelines_with_web",
    model: modelName,
    provider: "openrouter",
    searchEngine: "exa",
    fetchEngine: "exa",
    requestProfile: "exa-v1",
    apiKind: responsesApi ? "responses" : "chat",
    startedAt: new Date(startedAt).toISOString(),
    status: "running",
    system,
    prompt,
    limits: { ...WEB_RESEARCH_LIMITS, maxOutputTokens, modelRetries: 5 },
    requests: [],
    citations: [],
    serverToolItems: [],
    partialText: "",
  };
  let lastPersist = 0;
  const persist = (force = false): void => {
    if (!force && Date.now() - lastPersist < 1_000) return;
    saveWebResearchTrace(tracePath, trace, apiKey);
    lastPersist = Date.now();
  };
  let rawUsage: JsonObject | undefined;
  let finished = false;
  let responseBytes = 0;
  let timeToFirstTokenMs: number | undefined;
  const citationKeys = new Set<string>();

  function observe(event: JsonObject): void {
    const response = object(event.response);
    rawUsage = object(response?.usage ?? event.usage) ?? rawUsage;
    trace.routerMetadata =
      event.openrouter_metadata ??
      response?.openrouter_metadata ??
      trace.routerMetadata;
    const item = object(event.item);
    const items = [
      ...(event.type === "response.output_item.done" && item ? [item] : []),
      ...(Array.isArray(response?.output) ? response.output : []),
    ];
    for (const value of items) {
      if (!isWebItem(value)) continue;
      const toolItem = value as JsonObject;
      const index = trace.serverToolItems.findIndex(
        (old) => old.id === toolItem.id,
      );
      if (index >= 0) trace.serverToolItems[index] = toolItem;
      else trace.serverToolItems.push(toolItem);
    }
    const choices = Array.isArray(event.choices) ? event.choices : [];
    for (const choice of choices) {
      const annotations = object(object(choice)?.delta)?.annotations;
      if (!Array.isArray(annotations)) continue;
      for (const annotation of annotations) {
        const key = JSON.stringify(annotation);
        if (!citationKeys.has(key)) {
          citationKeys.add(key);
          trace.citations.push(annotation);
        }
      }
    }
    // A finishing chat chunk need not include annotations.
    finished ||= choices.some(
      (choice) => object(choice)?.finish_reason != null,
    );
    // A token-limit cutoff is a completed model attempt, not an outage.
    finished ||=
      event.type === "response.completed" ||
      event.type === "response.incomplete";
    if (
      event.error ||
      response?.error ||
      event.type === "response.failed" ||
      event.type === "response.error"
    ) {
      const message = object(event.error ?? response?.error)?.message;
      throw new InfrastructureError(
        "OpenRouter web response failed: " +
          (typeof message === "string" ? message : "provider error"),
      );
    }
  }

  const researchFetch = Object.assign(
    async (
      input: Parameters<FetchFunction>[0],
      init?: Parameters<FetchFunction>[1],
    ): Promise<Response> => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (
        ![
          OPENROUTER_BASE_URL + "/chat/completions",
          OPENROUTER_BASE_URL + "/responses",
        ].includes(url)
      ) {
        throw new InfrastructureError(
          "Web research requires an OpenRouter completion endpoint.",
        );
      }
      if (typeof init?.body !== "string") {
        throw new InfrastructureError("Expected a JSON OpenRouter request.");
      }
      const bodyObject = object(JSON.parse(init.body));
      if (!bodyObject)
        throw new InfrastructureError("Expected an OpenRouter request object.");
      const request = withWebResearchTools(bodyObject);
      const attempt: RequestTrace = {
        startedAt: new Date().toISOString(),
        request,
        events: [],
      };
      trace.requests.push(attempt);
      persist(true);
      const headers = new Headers(init.headers);
      headers.set("X-OpenRouter-Metadata", "enabled");
      const response = await fetchImpl(input, {
        ...init,
        headers,
        body: JSON.stringify(request),
      });
      attempt.httpStatus = response.status;
      persist(true);
      if (!response.ok || !response.body) return response;

      const encoder = new TextEncoder();
      const body = response.body
        .pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
              responseBytes += chunk.byteLength;
              if (responseBytes > WEB_RESEARCH_LIMITS.maxResponseBytes) {
                throw new InfrastructureError(
                  "OpenRouter web response exceeded the size limit.",
                );
              }
              controller.enqueue(chunk);
            },
          }),
        )
        .pipeThrough(new TextDecoderStream())
        .pipeThrough(new EventSourceParserStream())
        .pipeThrough(
          new TransformStream({
            transform(event, controller) {
              if (event.data === "[DONE]") {
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                return;
              }
              const value = object(JSON.parse(event.data));
              if (!value)
                throw new InfrastructureError(
                  "Invalid OpenRouter stream event.",
                );
              attempt.events.push(value);
              observe(value);
              persist();
              const visible = responsesApi ? sdkResponseEvent(value) : value;
              if (visible) {
                controller.enqueue(
                  encoder.encode(
                    (event.event ? "event: " + event.event + "\n" : "") +
                      "data: " +
                      JSON.stringify(visible) +
                      "\n\n",
                  ),
                );
              }
            },
          }),
        );
      // Do not reuse transport length/encoding headers for the rewritten stream.
      const responseHeaders = new Headers({
        "Content-Type": "text/event-stream",
      });
      const generationId = response.headers.get("x-generation-id");
      if (generationId) responseHeaders.set("x-generation-id", generationId);
      return new Response(body, {
        status: response.status,
        headers: responseHeaders,
      });
    },
    { preconnect: fetchImpl.preconnect },
  );

  persist(true);
  try {
    // OpenRouter owns the server-tool loop; our usual SDK adapter still handles
    // prompt serialization, model streaming and final generated code.
    const result = streamText({
      model: createModel(researchFetch),
      system,
      prompt,
      maxOutputTokens,
      maxRetries: 5,
      headers: sessionId ? { "x-session-id": sessionId } : undefined,
      abortSignal: signal,
      providerOptions: responsesApi
        ? { openai: { reasoningEffort: "medium" } }
        : undefined,
    });
    for await (const part of result.fullStream) {
      if (part.type === "error") throw part.error;
      if (part.type === "text-delta") {
        timeToFirstTokenMs ??= Date.now() - startedAt;
        trace.partialText += part.text;
        persist();
      }
    }
    if (signal.aborted || !finished) {
      throw new InfrastructureError(
        "OpenRouter web generation ended before completion.",
      );
    }
    const [text, usage, finishReason, response] = await Promise.all([
      result.text,
      result.usage,
      result.finishReason,
      result.response,
    ]);
    if (finishReason === "error") {
      throw new InfrastructureError("OpenRouter web generation failed.");
    }
    // In particular, the OpenAI Responses adapter drops OpenRouter's cost and
    // search counters. Preserve the terminal wire usage rather than estimating
    // a token-only total that would omit web charges.
    const reportedUsage: LanguageModelUsage = {
      ...usage,
      raw: (rawUsage as LanguageModelUsage["raw"]) ?? usage.raw,
    };
    trace.usage = reportedUsage;
    trace.status = "completed";
    return { text, usage: reportedUsage, trace, timeToFirstTokenMs, response };
  } catch (error) {
    trace.status = "failed";
    trace.error = (
      error instanceof Error ? error.message : String(error)
    ).replaceAll(apiKey, "[redacted]");
    abort.abort(error);
    throw new InfrastructureError(
      "OpenRouter web generation failed: " + trace.error,
    );
  } finally {
    const counters = object(
      rawUsage?.server_tool_use_details ?? rawUsage?.server_tool_use,
    );
    trace.summary = {
      searchRequests: count(counters?.web_search_requests),
      fetchRequests: count(counters?.web_fetch_requests),
      toolCallsRequested: count(counters?.tool_calls_requested),
      toolCallsExecuted: count(counters?.tool_calls_executed),
      observedSearchItems: trace.serverToolItems.filter(
        (item) => item.type === "openrouter:web_search",
      ).length,
      observedFetchItems: trace.serverToolItems.filter(
        (item) => item.type === "openrouter:web_fetch",
      ).length,
      sourceCitations: trace.citations.length,
      requestAttempts: trace.requests.length,
      coverage: "provider-visible-only",
    };
    trace.completedAt = new Date().toISOString();
    persist(true);
  }
}
