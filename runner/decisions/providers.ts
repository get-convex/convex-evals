import type { ProviderConfig } from "./protocol.js";
import { buildSharedState, type PresentedQuestion } from "./questions.js";

export const PROVIDER_ENDPOINTS = {
  typesafe: "https://api.typesafe.ai/v1/systemone",
  openrouter: "https://openrouter.ai/api/v1/chat/completions",
  openrouterDecisions: "https://openrouter.ai/api/alpha/decisions",
} as const;

/** Routing and response shape are independent: OpenRouter also serves native
 * typed decisions. Keep supported slugs explicit rather than sending Jev to chat. */
export function usesNativeDecisionApi(
  config: Pick<ProviderConfig, "provider" | "model">,
): boolean {
  return (
    config.provider === "typesafe" ||
    (config.provider === "openrouter" &&
      ["typesafe/jev-1.13", "~typesafe/jev-latest"].includes(config.model))
  );
}

export function providerEndpoint(config: ProviderConfig): string {
  if (config.provider === "typesafe") return PROVIDER_ENDPOINTS.typesafe;
  return usesNativeDecisionApi(config)
    ? PROVIDER_ENDPOINTS.openrouterDecisions
    : PROVIDER_ENDPOINTS.openrouter;
}

export function buildProviderRequest(
  config: ProviderConfig,
  presented: PresentedQuestion,
  guidelines: string,
): Record<string, unknown> {
  const state = buildSharedState(presented, guidelines);
  if (usesNativeDecisionApi(config)) {
    return {
      model: config.model,
      state,
      questions: {
        decision: {
          type: "choice",
          instructions: presented.input.question,
          criteria: presented.input.options,
        },
      },
    };
  }
  return {
    model: config.model,
    messages: [
      {
        role: "user",
        content: JSON.stringify({
          state,
          question: presented.input.question,
          options: presented.input.options,
        }),
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "decision",
        strict: true,
        schema: {
          type: "object",
          properties: {
            choice: {
              type: "string",
              enum: Object.keys(presented.input.options),
            },
          },
          required: ["choice"],
          additionalProperties: false,
        },
      },
    },
    provider: { require_parameters: true },
    reasoning: { effort: config.reasoningEffort },
    max_tokens: config.maxOutputTokens,
  };
}

export interface ProviderAttempt {
  attempt: number;
  startedAt: string;
  durationMs: number;
  httpStatus: number | null;
  response: unknown;
  error: string | null;
}
export interface DecisionResponse {
  choice: string;
  probabilities: Record<string, number> | null;
  confidence: number | null;
  returnedModel: string | null;
  usage: Record<string, unknown> | null;
  costUsd: number | null;
}
export interface ProviderOutcome {
  kind: "answered" | "invalid_response" | "provider_error";
  answer: DecisionResponse | null;
  error: string | null;
  attempts: ProviderAttempt[];
  durationMs: number;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected an object");
  return value as Record<string, unknown>;
}

export function parseProviderResponse(
  config: ProviderConfig,
  raw: unknown,
  labels: string[],
): DecisionResponse {
  const body = object(raw);
  let answer: Record<string, unknown>;
  if (usesNativeDecisionApi(config)) {
    answer = object(object(body.answers).decision);
    if (answer.type !== "choice") throw new Error("Expected a Choice answer");
  } else {
    if (!Array.isArray(body.choices) || body.choices.length === 0)
      throw new Error("No provider choices");
    const result = object(body.choices[0]);
    if (result.finish_reason !== "stop")
      throw new Error(`Incomplete answer: ${String(result.finish_reason)}`);
    const message = object(result.message);
    if (typeof message.content !== "string")
      throw new Error("Missing structured response content");
    answer = object(JSON.parse(message.content));
    if (Object.keys(answer).some((key) => key !== "choice"))
      throw new Error("Unexpected structured answer fields");
  }
  if (typeof answer.choice !== "string" || !labels.includes(answer.choice))
    throw new Error("Choice is not a displayed option ID");
  let probabilities: Record<string, number> | null = null;
  let confidence: number | null = null;
  if (usesNativeDecisionApi(config)) {
    const values = object(answer.probabilities);
    if (
      Object.keys(values).length !== labels.length ||
      labels.some((label) => !(label in values))
    )
      throw new Error("Probability labels do not match options");
    if (
      Object.values(values).some(
        (value) =>
          typeof value !== "number" ||
          !Number.isFinite(value) ||
          value < 0 ||
          value > 1,
      )
    )
      throw new Error("Probabilities must be finite numbers in [0,1]");
    probabilities = values as Record<string, number>;
    const sum = Object.values(probabilities).reduce((a, b) => a + b, 0);
    // Jev 1.13 returns probabilities rounded to hundredths. Four independently
    // rounded values can legitimately total 0.98 through 1.02. Preserve those
    // native values; do not normalize or reject an otherwise valid choice.
    const roundedToHundredths = Object.values(probabilities).every(
      (value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-9,
    );
    const sumTolerance = roundedToHundredths
      ? labels.length * 0.005 + 1e-9
      : 0.001;
    if (Math.abs(sum - 1) > sumTolerance)
      throw new Error("Probabilities do not sum to one");
    if (
      probabilities[answer.choice] + 0.000001 <
      Math.max(...Object.values(probabilities))
    )
      throw new Error("Choice is not a highest-probability option");
    if (
      typeof answer.confidence !== "number" ||
      !Number.isFinite(answer.confidence) ||
      answer.confidence < 0 ||
      answer.confidence > 1
    )
      throw new Error("Invalid confidence");
    confidence = answer.confidence;
  }
  const usage =
    body.usage && typeof body.usage === "object" && !Array.isArray(body.usage)
      ? object(body.usage)
      : null;
  return {
    choice: answer.choice,
    probabilities,
    confidence,
    returnedModel: typeof body.model === "string" ? body.model : null,
    usage,
    costUsd:
      typeof usage?.cost === "number" &&
      Number.isFinite(usage.cost) &&
      usage.cost >= 0
        ? usage.cost
        : null,
  };
}

export interface ProviderDependencies {
  fetcher?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  onAttemptStart?: (attempt: ProviderAttempt) => void;
  onAttempt?: (attempt: ProviderAttempt) => void;
  beforeAttempt?: () => void;
}

export async function callProvider(
  config: ProviderConfig,
  request: Record<string, unknown>,
  key: string,
  dependencies: ProviderDependencies = {},
): Promise<ProviderOutcome> {
  const started = performance.now();
  const attempts: ProviderAttempt[] = [];
  const fetcher = dependencies.fetcher ?? fetch;
  const sleep =
    dependencies.sleep ??
    ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const finish = (
    kind: ProviderOutcome["kind"],
    answer: DecisionResponse | null,
    error: string | null,
  ): ProviderOutcome => ({
    kind,
    answer,
    error,
    attempts,
    durationMs: performance.now() - started,
  });
  for (let index = 0; index <= config.maxRetries; index++) {
    try {
      dependencies.beforeAttempt?.();
    } catch (error) {
      return finish(
        "provider_error",
        null,
        error instanceof Error ? error.message : "Request budget reached",
      );
    }
    const at = performance.now();
    const attempt: ProviderAttempt = {
      attempt: index + 1,
      startedAt: new Date().toISOString(),
      durationMs: 0,
      httpStatus: null,
      response: null,
      error: null,
    };
    dependencies.onAttemptStart?.(attempt);
    let retryAfterMs = 0;
    try {
      const response = await fetcher(providerEndpoint(config), {
        method: "POST",
        redirect: "error",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(config.timeoutMs),
      });
      attempt.httpStatus = response.status;
      const raw = await response.text();
      try {
        attempt.response = JSON.parse(raw);
      } catch {
        attempt.response = raw;
      }
      const retryAfter = response.headers.get("retry-after");
      if (retryAfter) {
        const seconds = Number(retryAfter);
        retryAfterMs = Number.isFinite(seconds)
          ? seconds * 1000
          : Date.parse(retryAfter) - Date.now();
      }
      if (!response.ok) attempt.error = `HTTP ${response.status}`;
    } catch (error) {
      // Network errors can include URLs, but never log request headers or keys.
      attempt.error =
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : "Network request failed";
    }
    attempt.durationMs = performance.now() - at;
    attempts.push(attempt);
    dependencies.onAttempt?.(attempt);
    if (!attempt.error) {
      try {
        return finish(
          "answered",
          parseProviderResponse(config, attempt.response, ["A", "B", "C", "D"]),
          null,
        );
      } catch (error) {
        return finish(
          "invalid_response",
          null,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    const retryable =
      attempt.httpStatus === null ||
      [408, 429, 500, 502, 503, 504, 529].includes(attempt.httpStatus);
    if (!retryable || index === config.maxRetries)
      return finish("provider_error", null, attempt.error);
    await sleep(
      Math.min(
        30_000,
        Math.max(
          1000 * 2 ** index,
          Number.isFinite(retryAfterMs) ? retryAfterMs : 0,
        ),
      ),
    );
  }
  return finish("provider_error", null, "Retry budget exhausted");
}
