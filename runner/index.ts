#!/usr/bin/env bun
/**
 * Main evaluation orchestrator.
 *
 * Usage:
 *   bun run runner/index.ts
 *
 * Environment variables:
 *   MODELS           - comma-separated model names (default: see below)
 *   TEST_FILTER      - regex to filter evals by "category/name"
 *   OUTPUT_TEMPDIR   - output directory (default: OS temp dir)
 *   EVALS_EXPERIMENT - experiment name (e.g. "no_guidelines")
 *   EVALS_EXECUTION_MODE - "generate" (default) or "answer"
 *   CONVEX_EVAL_URL  - Convex deployment URL (e.g. "https://xxx.convex.cloud")
 *   CONVEX_AUTH_TOKEN - auth token for the Convex backend
 *   CUSTOM_GUIDELINES_PATH - path to custom guidelines markdown file
 */
import { readdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { config } from "dotenv";

import {
  ALL_MODELS,
  MODEL_NAMES,
  type ResolvedModel,
  resolveModelDefaults,
  OPENROUTER_API_KEY_VAR,
  DEFAULT_MAX_CONCURRENCY,
} from "./models/index.js";
import {
  resolveModel,
  preflightOpenRouterEndpoint,
} from "./models/openRouterDiscovery.js";
import { logInfo } from "./logging.js";
import {
  Model,
  EmptyProviderResponseError,
  attachProviderObservabilityUsage,
  type ProviderAttempt,
} from "./models/modelCodegen.js";
import { convexScorer, getEvalPipeline, walkAnswer } from "./scorer.js";
import { InfrastructureError } from "./convexBackend.js";
import {
  isWebResearchExperiment,
  validateExperimentConfiguration,
} from "./experiments.js";
import { requireWebResearchApiKey } from "./models/webResearchTools.js";
import { computeBenchmarkDefinition } from "./benchmark.js";
import {
  ensureModelFromSlug,
  startRun,
  completeRun,
  startEval,
  completeEval,
  getOrUploadEvalSource,
  printEvalSummary,
  closeClient,
  type EvalIndividualResult,
} from "./reporting.js";
import type { LanguageModelUsage } from "ai";

config(); // Load .env

// ── Run configuration ─────────────────────────────────────────────────

/**
 * Configuration for a single eval run. Can be constructed from env vars
 * (via `configFromEnv()`) or programmatically for use by scripts like
 * the ablation runner.
 */
export interface RunConfig {
  model: ResolvedModel;
  provider?: string;
  tempdir: string;
  testFilter?: RegExp;
  executionMode?: ExecutionMode;
  customGuidelinesPath?: string;
  convexEvalUrl?: string;
  convexAuthToken?: string;
  experiment?: string;
}

type ExecutionMode = "generate" | "answer";

const ANSWER_VALIDATION_MODEL: ResolvedModel = {
  ...resolveModelDefaults("answer-validation"),
  formattedName: "Answer Validation",
};

type SharedRunOptions = Omit<RunConfig, "model" | "executionMode">;

export function runAnswerValidation(
  config: SharedRunOptions,
): Promise<EvalIndividualResult[]> {
  return runEvalsForModel({
    ...config,
    model: ANSWER_VALIDATION_MODEL,
    executionMode: "answer",
  });
}

// ── Default models ────────────────────────────────────────────────────

// Keep one source of truth for both scheduled and ad-hoc default runs.
const DEFAULT_MODEL_NAMES = ALL_MODELS;

// ── Eval discovery ────────────────────────────────────────────────────

interface EvalInfo {
  category: string;
  name: string;
  evalPath: string;
}

function discoverEvals(): EvalInfo[] {
  const evalsDir = "evals";
  if (!existsSync(evalsDir)) return [];

  const results: EvalInfo[] = [];
  const categories = readdirSync(evalsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const category of categories) {
    const categoryPath = join(evalsDir, category.name);
    const evalDirs = readdirSync(categoryPath, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const evalDir of evalDirs) {
      const evalPath = join(categoryPath, evalDir.name);
      if (existsSync(join(evalPath, "TASK.txt"))) {
        results.push({
          category: category.name,
          name: evalDir.name,
          evalPath,
        });
      }
    }
  }
  return results;
}

// ── Score name to failure reason mapping ──────────────────────────────

const SCORE_FAILURE_REASONS: Record<string, string> = {
  "Valid filesystem output": "filesystem fail",
  "`bun install` succeeds": "install fail",
  "`convex dev` succeeds": "convex dev fail",
  "Passes tsc": "tsc fail",
  "Passes eslint": "eslint fail",
  "Tests pass": "tests fail",
};

/** Stop on the first failure, then drain owned work before returning control. */
export async function runEvalQueue<T>(
  items: readonly T[],
  concurrency: number,
  processItem: (item: T) => Promise<void>,
): Promise<void> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error("Eval concurrency must be a positive integer");
  }
  const state: { next: number; failure?: { error: unknown } } = { next: 0 };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (!state.failure && state.next < items.length) {
        const item = items[state.next++];
        try {
          await processItem(item);
        } catch (error) {
          state.failure ??= { error };
        }
      }
    }),
  );
  // Every worker handles its rejection, including failures after the first.
  // Shared run environment and reporting remain active until they all settle.
  if (state.failure) throw state.failure.error;
}

// ── Main (CLI entrypoint) ─────────────────────────────────────────────

async function main(): Promise<void> {
  validateExperimentConfiguration(process.env.EVALS_EXPERIMENT);
  validateWebResearchRun(process.env.EVALS_EXPERIMENT);
  const executionMode = parseExecutionMode(process.env.EVALS_EXECUTION_MODE);
  const modelNames = process.env.MODELS
    ? process.env.MODELS.split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : DEFAULT_MODEL_NAMES;

  const resolvedModels: Array<{
    model: ResolvedModel;
    provider: string;
    openRouterFirstSeenAt?: number;
  }> = [];
  for (const modelName of modelNames) {
    const isKnown = MODEL_NAMES.has(modelName);
    const resolved = await resolveModel(modelName);

    if (!isKnown && !resolved.discovered) {
      console.error(
        `Model ${modelName} not supported and not found on OpenRouter`,
      );
      process.exit(1);
    }

    if (!isKnown) {
      logInfo(
        `Discovered dynamic model ${modelName} (${resolved.model.formattedName})`,
      );
    }

    resolvedModels.push(resolved);
  }

  const td =
    process.env.OUTPUT_TEMPDIR ?? join(tmpdir(), `convex-evals-${Date.now()}`);
  logInfo(`Using tempdir: ${td}`);

  const tf = process.env.TEST_FILTER
    ? new RegExp(process.env.TEST_FILTER)
    : undefined;

  for (const resolved of resolvedModels) {
    const cfg: RunConfig = {
      model: resolved.model,
      provider: resolved.provider,
      tempdir: td,
      testFilter: tf,
      executionMode,
      customGuidelinesPath: process.env.CUSTOM_GUIDELINES_PATH,
      convexEvalUrl: process.env.CONVEX_EVAL_URL,
      convexAuthToken: process.env.CONVEX_AUTH_TOKEN,
      experiment: process.env.EVALS_EXPERIMENT,
    };
    await runEvalsForModel(cfg, {
      openRouterFirstSeenAt: resolved.openRouterFirstSeenAt,
    });
  }

  await closeClient();

  // Force-exit: the ConvexClient WebSocket and fire-and-forget recordStep
  // promises can keep the event loop alive after all work is done, causing
  // CI jobs to hang until they hit the GitHub Actions timeout.
  process.exit(0);
}

/**
 * Run all evals for a single model and return per-eval results.
 *
 * Can be called programmatically (e.g. from the ablation runner) or
 * via the CLI entrypoint above.
 */
export async function runEvalsForModel(
  config: RunConfig,
  metadata?: {
    openRouterFirstSeenAt?: number;
  },
): Promise<EvalIndividualResult[]> {
  validateExperimentConfiguration(config.experiment);
  validateWebResearchRun(config.experiment);
  if (isWebResearchExperiment(config.experiment)) {
    if (config.customGuidelinesPath)
      throw new Error(
        "no_guidelines_with_web does not allow custom guidelines.",
      );
    if (config.executionMode === "answer")
      throw new Error(
        "no_guidelines_with_web requires model generation, not answer validation.",
      );
  }
  const {
    model,
    provider = "openrouter",
    tempdir,
    testFilter,
    executionMode = "generate",
    convexEvalUrl,
    convexAuthToken,
  } = config;
  const modelDisplayName = model.formattedName;

  // Set CUSTOM_GUIDELINES_PATH so getGuidelinesContent() in modelCodegen
  // picks it up. We restore it afterwards to avoid cross-run leakage.
  const prevGuidelinesPath = process.env.CUSTOM_GUIDELINES_PATH;
  if (config.customGuidelinesPath) {
    process.env.CUSTOM_GUIDELINES_PATH = config.customGuidelinesPath;
  } else {
    delete process.env.CUSTOM_GUIDELINES_PATH;
  }

  // Similarly for EVALS_EXPERIMENT
  const prevExperiment = process.env.EVALS_EXPERIMENT;
  if (config.experiment) {
    process.env.EVALS_EXPERIMENT = config.experiment;
  } else {
    delete process.env.EVALS_EXPERIMENT;
  }

  try {
    const evalPaths = discoverEvals();
    const benchmark = computeBenchmarkDefinition(
      evalPaths.map(({ evalPath }) => evalPath),
    );
    const filteredPaths = testFilter
      ? evalPaths.filter(({ category, name }) =>
          testFilter.test(`${category}/${name}`),
        )
      : evalPaths;

    logInfo(
      `Running ${filteredPaths.length} evals for model ${modelDisplayName}`,
    );

    // Start run if Convex is configured
    let runId: string | null = null;
    const runStartTime = Date.now();

    if (convexEvalUrl && convexAuthToken) {
      const plannedEvals = filteredPaths.map((e) => `${e.category}/${e.name}`);
      const modelId = await ensureModelFromSlug(
        model.name,
        modelDisplayName,
        provider,
        model.apiKind,
        metadata?.openRouterFirstSeenAt,
      );
      if (modelId) {
        runId = await startRun(
          modelId,
          plannedEvals,
          provider,
          config.experiment,
          benchmark.version,
        );
        if (runId) {
          logInfo(
            `Started run ${runId} for model ${model.name} with ${plannedEvals.length} evals`,
          );
        } else {
          logInfo(
            "Failed to start run in Convex (endpoint may not be configured)",
          );
        }
      } else {
        logInfo(
          `Skipping Convex reporting for ${model.name} (reporting disabled or endpoint unavailable)`,
        );
      }
    }

    let modelImpl: Model | null = null;
    let modelApiKey: string | null = null;
    if (executionMode === "generate") {
      const apiKey = process.env[OPENROUTER_API_KEY_VAR];
      if (!apiKey) {
        console.error(`${OPENROUTER_API_KEY_VAR} is not set`);
        process.exit(1);
      }
      modelApiKey = apiKey;
    }

    if (executionMode === "generate" && modelApiKey) {
      logInfo(
        `[preflight] Checking endpoint availability for ${model.name}...`,
      );
      try {
        await preflightOpenRouterEndpoint(model, modelApiKey);
        logInfo(`[preflight] Endpoint is available for ${model.name}`);
      } catch (error) {
        const reason = `[infrastructure] [preflight] ${String(error)}`;
        console.error(
          `[preflight] Endpoint unavailable for ${model.name}: ${String(error)}`,
        );
        if (runId) {
          await completeRun(runId, {
            kind: "failed",
            failureReason: reason,
            durationMs: Date.now() - runStartTime,
          });
          logInfo(`Run failed: ${reason}`);
          runId = null;
        }
        throw new InfrastructureError(String(error));
      }
      modelImpl = new Model(modelApiKey, model);
    }

    const allResults: EvalIndividualResult[] = [];

    try {
      await runEvalQueue(filteredPaths, DEFAULT_MAX_CONCURRENCY, (evalInfo) =>
        processOneEval(
          model,
          modelImpl,
          executionMode,
          evalInfo,
          runId,
          allResults,
          filteredPaths.length,
          tempdir,
        ),
      );
    } catch (e) {
      if (e instanceof InfrastructureError) {
        const reason = `[infrastructure] ${e.message}`;
        console.error(`Infrastructure failure, aborting run: ${e.message}`);
        if (runId) {
          await completeRun(runId, {
            kind: "failed",
            failureReason: reason,
            durationMs: Date.now() - runStartTime,
          });
          logInfo(`Run failed: ${reason}`);
        }
        throw e;
      }
      throw e;
    }

    // Invalidate the entire run if any eval reports zero total tokens.
    // Keep the failed run as scheduling evidence so periodic evals do not
    // retry the same provider failure on every tick.
    if (executionMode === "generate" && runId) {
      const zeroTokenEval = allResults.find((result) =>
        hasZeroTotalTokens(result.usage),
      );
      if (zeroTokenEval) {
        const evalPath = `${zeroTokenEval.category}/${zeroTokenEval.name}`;
        const reason = `[infrastructure] [zero_tokens] Zero total token usage detected for ${evalPath}`;
        console.error(`Run invalid, marking ${runId} failed: ${reason}`);
        await completeRun(runId, {
          kind: "failed",
          failureReason: reason,
          durationMs: Date.now() - runStartTime,
        });
        logInfo(`Marked run ${runId} as failed due to zero-token eval usage`);
        runId = null;
        throw new InfrastructureError(reason);
      }
    }

    // Print summary
    printEvalSummary(modelDisplayName, allResults);

    if (
      executionMode === "answer" &&
      allResults.some((result) => !result.passed)
    ) {
      const reason =
        "[answer_validation] Canonical answers must pass all evals";
      if (runId) {
        await completeRun(runId, {
          kind: "failed",
          failureReason: reason,
          durationMs: Date.now() - runStartTime,
        });
      }
      throw new Error(reason);
    }

    // Complete run
    if (runId) {
      const runUsage: LanguageModelUsage = {
        inputTokens: 0,
        inputTokenDetails: {
          noCacheTokens: undefined,
          cacheReadTokens: undefined,
          cacheWriteTokens: undefined,
        },
        outputTokens: 0,
        outputTokenDetails: {
          textTokens: undefined,
          reasoningTokens: undefined,
        },
        totalTokens: 0,
      };
      for (const r of allResults) {
        if (r.usage) {
          if (typeof r.usage.inputTokens === "number")
            runUsage.inputTokens =
              (runUsage.inputTokens ?? 0) + r.usage.inputTokens;
          if (typeof r.usage.outputTokens === "number")
            runUsage.outputTokens =
              (runUsage.outputTokens ?? 0) + r.usage.outputTokens;
          if (typeof r.usage.totalTokens === "number")
            runUsage.totalTokens =
              (runUsage.totalTokens ?? 0) + r.usage.totalTokens;
        }
      }

      await completeRun(runId, {
        kind: "completed",
        durationMs: Date.now() - runStartTime,
        usage: runUsage,
      });
      logInfo(`Completed run ${runId}`);
    }

    return allResults;
  } finally {
    // Restore env vars
    if (prevGuidelinesPath !== undefined) {
      process.env.CUSTOM_GUIDELINES_PATH = prevGuidelinesPath;
    } else {
      delete process.env.CUSTOM_GUIDELINES_PATH;
    }
    if (prevExperiment !== undefined) {
      process.env.EVALS_EXPERIMENT = prevExperiment;
    } else {
      delete process.env.EVALS_EXPERIMENT;
    }
  }
}

const PROVIDER_MAX_RETRIES = 2; // 3 total attempts
const RATE_LIMIT_RETRY_BASE_MS = 30_000; // 30s, then 60s
const TRANSIENT_RETRY_BASE_MS = 2_000; // 2s, then 4s

/** Process a single eval. */
async function processOneEval(
  model: ResolvedModel,
  modelImpl: Model | null,
  executionMode: ExecutionMode,
  evalInfo: EvalInfo,
  runId: string | null,
  allResults: EvalIndividualResult[],
  totalEvals: number,
  tempdir: string,
): Promise<void> {
  const { category, name, evalPath } = evalInfo;
  const evalPathStr = `${category}/${name}`;

  if (executionMode === "answer") {
    logInfo(`[${evalPathStr}] Running canonical answer validation...`);
  } else {
    logInfo(`[${evalPathStr}] Calling model ${model.formattedName}...`);
  }

  // Read task description and expected files
  const taskDescription = readFileSync(join(evalPath, "TASK.txt"), "utf-8");
  const expected = readExpectedFiles(evalPath);

  // Start eval in Convex if available
  let evalId: string | null = null;
  if (runId) {
    const { taskContent, storageId } = await getOrUploadEvalSource(evalPath);
    evalId = await startEval(
      runId,
      evalPathStr,
      category,
      name,
      taskContent ?? undefined,
      storageId ?? undefined,
    );
  }

  const metadata: Record<string, unknown> = {
    name: evalPathStr,
    category,
    eval_name: name,
    model: model.name,
    model_name: model.formattedName,
    tempdir,
    eval_id: evalId,
    run_id: runId,
  };

  const evalStartTime = Date.now();

  if (executionMode === "answer") {
    const output = readAnswerOutputFiles(evalPath);
    logInfo(`[${evalPathStr}] Using canonical answer output, scoring...`);
    const scores = await convexScorer(
      tempdir,
      taskDescription,
      expected,
      metadata,
      output,
    );
    const result = buildEvalResult(category, name, model.name, scores, tempdir);
    allResults.push(result);
    logProgress(evalPathStr, result, allResults, totalEvals, evalStartTime);
    return;
  }

  if (modelImpl === null) {
    throw new Error(`Model implementation missing for mode: ${executionMode}`);
  }

  // One session ID groups all provider attempts for this eval. OpenRouter's
  // generation ID still identifies each individual attempt inside that group.
  const requestSessionId = randomUUID();
  const providerAttempts: ProviderAttempt[] = [];

  // Retry provider-side failures that are expected to be transient. Model
  // answers that contain text are still scored normally, even if malformed.
  let generateResult: {
    files: Record<string, string>;
    usage: LanguageModelUsage | undefined;
    rawResponse: string;
  } | null = null;
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= PROVIDER_MAX_RETRIES; attempt++) {
    const attemptStartedAt = Date.now();
    try {
      const webTracePath = isWebResearchExperiment(process.env.EVALS_EXPERIMENT)
        ? join(
            tempdir,
            "research",
            model.name,
            category,
            name,
            `attempt-${attempt + 1}.json`,
          )
        : undefined;
      if (webTracePath)
        logInfo(`[${evalPathStr}] Research trace: ${webTracePath}`);
      const { files, usage, rawResponse, openRouterGenerationId } =
        await modelImpl.generate(taskDescription, {
          sessionId: requestSessionId,
          webTracePath,
          ...(getEvalPipeline(category, name) === "module"
            ? { moduleOnly: true }
            : {}),
        });
      providerAttempts.push({
        attempt: attempt + 1,
        durationMs: Date.now() - attemptStartedAt,
        outcome: "success",
        openRouterGenerationId,
      });
      logInfo(
        `[${evalPathStr}] Provider IDs: session=${requestSessionId} generation=${openRouterGenerationId ?? "unavailable"}`,
      );
      generateResult = {
        files,
        usage: attachProviderObservabilityUsage({
          usage,
          sessionId: requestSessionId,
          attempts: providerAttempts,
        }),
        rawResponse,
      };
      break;
    } catch (e) {
      // Infrastructure failures always abort immediately - no retry.
      if (e instanceof InfrastructureError) throw e;

      lastError = e;
      const errorStr = String(e);
      const rateLimited = isRateLimitError(errorStr);
      const transient = isTransientProviderError(e);
      providerAttempts.push({
        attempt: attempt + 1,
        durationMs: Date.now() - attemptStartedAt,
        outcome:
          e instanceof EmptyProviderResponseError
            ? "empty_response"
            : rateLimited
              ? "rate_limit"
              : transient
                ? "transient_error"
                : "error",
        openRouterGenerationId:
          e instanceof EmptyProviderResponseError
            ? e.openRouterGenerationId
            : undefined,
      });
      logInfo(
        `[${evalPathStr}] Provider attempt ${attempt + 1}: session=${requestSessionId} generation=${
          e instanceof EmptyProviderResponseError
            ? (e.openRouterGenerationId ?? "unavailable")
            : "unavailable"
        } outcome=${providerAttempts[providerAttempts.length - 1].outcome}`,
      );

      if (transient && attempt < PROVIDER_MAX_RETRIES) {
        const delayMs =
          (rateLimited ? RATE_LIMIT_RETRY_BASE_MS : TRANSIENT_RETRY_BASE_MS) *
          Math.pow(2, attempt);
        logInfo(
          `[${evalPathStr}] Transient provider failure, retrying in ${delayMs / 1000}s (attempt ${attempt + 1}/${PROVIDER_MAX_RETRIES})...`,
        );
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
      break;
    }
  }

  if (generateResult !== null) {
    const { files: output, usage, rawResponse } = generateResult;
    const generationDurationMs = Date.now() - evalStartTime;

    if (usage) {
      metadata.usage = usage;
    }
    metadata.generationDurationMs = generationDurationMs;
    if (Object.keys(output).length === 0) {
      metadata.raw_model_response_debug = truncateRawModelResponse(rawResponse);
      metadata.raw_model_response_length = rawResponse.length;
    }

    const generateDuration = (generationDurationMs / 1000).toFixed(1);
    logInfo(
      `[${evalPathStr}] Model responded (${generateDuration}s), scoring...`,
    );

    const scores = await convexScorer(
      tempdir,
      taskDescription,
      expected,
      metadata,
      output,
    );

    const result = buildEvalResult(
      category,
      name,
      model.name,
      scores,
      tempdir,
      usage,
    );
    allResults.push(result);
    logProgress(evalPathStr, result, allResults, totalEvals, evalStartTime);
    return;
  }

  // Generation failed after all attempts.
  const errorStr = String(lastError);
  const rateLimited = isRateLimitError(errorStr);
  const infrastructureFailure = isTransientProviderError(lastError);
  const prefix = rateLimited
    ? "[rate_limit] "
    : infrastructureFailure
      ? "[infrastructure] "
      : "";
  const failureUsage = attachProviderObservabilityUsage({
    usage: undefined,
    sessionId: requestSessionId,
    attempts: providerAttempts,
  });
  console.error(`[${evalPathStr}] ERROR: ${errorStr}`);
  allResults.push({
    category,
    name,
    passed: false,
    tests_pass_score: 0,
    failure_reason: `${prefix}error: ${errorStr}`,
    directory_path: null,
    scores: {},
  });

  // Mark the eval as failed in Convex so the run can be fully completed.
  // Without this, the eval stays "pending" and isFullyCompletedRun returns
  // false, preventing the run from appearing on the leaderboard.
  // Provider failures retain their labels for reliability reporting, but they
  // still count as failed evals in the leaderboard score.
  if (evalId) {
    await completeEval(evalId, {
      kind: "failed",
      failureReason: `${prefix}error: ${errorStr}`,
      durationMs: Date.now() - evalStartTime,
      generationDurationMs: Date.now() - evalStartTime,
      usage: failureUsage,
    });
  }

  logProgress(
    evalPathStr,
    allResults[allResults.length - 1],
    allResults,
    totalEvals,
    evalStartTime,
  );

  return;
}

// ── Helpers ───────────────────────────────────────────────────────────

/** Detect whether an error is a rate-limit / quota error from the provider. */
function isRateLimitError(errorStr: string): boolean {
  const lower = errorStr.toLowerCase();
  return (
    lower.includes("rate limit") ||
    lower.includes("rate_limit") ||
    lower.includes("too many requests") ||
    lower.includes("quota") ||
    lower.includes("429") ||
    lower.includes("throttl")
  );
}

/** Detect empty/capacity/network failures that are safe to retry. */
function isTransientProviderError(error: unknown): boolean {
  if (error instanceof EmptyProviderResponseError) return true;
  const lower = String(error).toLowerCase();
  return (
    isRateLimitError(lower) ||
    lower.includes("at capacity") ||
    lower.includes("high demand") ||
    lower.includes("temporarily unavailable") ||
    lower.includes("service unavailable") ||
    lower.includes("overloaded") ||
    lower.includes("timeout") ||
    lower.includes("timed out") ||
    lower.includes("econnreset") ||
    lower.includes("connection reset") ||
    /\b50[234]\b/.test(lower)
  );
}

function hasZeroTotalTokens(usage: LanguageModelUsage | undefined): boolean {
  if (!usage) return false;
  if (usage.totalTokens === 0) return true;

  const input =
    typeof usage.inputTokens === "number" ? usage.inputTokens : undefined;
  const output =
    typeof usage.outputTokens === "number" ? usage.outputTokens : undefined;
  if (input !== undefined && output !== undefined && input + output === 0) {
    return true;
  }
  return false;
}

function truncateRawModelResponse(response: string): string {
  const maxChars = 16_000;
  if (response.length <= maxChars) return response;
  return `${response.slice(0, maxChars)}\n\n[truncated ${response.length - maxChars} chars]`;
}

function parseExecutionMode(value: string | undefined): ExecutionMode {
  if (!value || value === "generate") return "generate";
  if (value === "answer") return "answer";
  console.error(`Invalid EVALS_EXECUTION_MODE: ${value}`);
  process.exit(1);
}

function validateWebResearchRun(experiment: string | undefined): void {
  if (!isWebResearchExperiment(experiment)) return;
  requireWebResearchApiKey();
}

function readExpectedFiles(evalPath: string): Record<string, string> {
  const answerPaths = [...walkAnswer(join(evalPath, "answer"))].sort(
    (a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b),
  );
  const expected: Record<string, string> = {};
  const basePath = join(evalPath, "answer");
  for (const filePath of answerPaths) {
    const relativePath = filePath
      .slice(basePath.length + 1)
      .replace(/\\/g, "/");
    expected[relativePath] = readFileSync(filePath, "utf-8").trim();
  }
  return expected;
}

function readAnswerOutputFiles(evalPath: string): Record<string, string> {
  const answerPaths = [...walkAnswer(join(evalPath, "answer"))].sort(
    (a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b),
  );
  const output: Record<string, string> = {};
  const basePath = join(evalPath, "answer");
  for (const filePath of answerPaths) {
    const relativePath = filePath
      .slice(basePath.length + 1)
      .replace(/\\/g, "/");
    output[relativePath] = readFileSync(filePath, "utf-8");
  }
  return output;
}

export function buildEvalResult(
  category: string,
  name: string,
  modelName: string,
  scores: Array<{ name: string; score: number }>,
  tempdir: string,
  usage?: LanguageModelUsage,
): EvalIndividualResult {
  const scoresMap: Record<string, number> = {};
  for (const s of scores) {
    scoresMap[s.name] = s.score;
  }

  const testsPassScore = scoresMap["Tests pass"] ?? 0;
  // Keep local run summary consistent with Convex eval completion status:
  // an eval only passes if every recorded scoring step is perfect and tests are 100%.
  const passed = scores.length > 0 && scores.every((s) => s.score >= 1);

  let failureReason: string | null = null;
  if (!passed) {
    for (const s of scores) {
      if (s.score < 1 && SCORE_FAILURE_REASONS[s.name]) {
        failureReason = SCORE_FAILURE_REASONS[s.name];
        break;
      }
    }
    failureReason ??= "unknown fail";
  }

  return {
    category,
    name,
    passed,
    tests_pass_score: testsPassScore,
    failure_reason: failureReason,
    directory_path: join(tempdir, "output", modelName, category, name),
    scores: scoresMap,
    usage,
  };
}

function logProgress(
  evalPathStr: string,
  result: EvalIndividualResult,
  allResults: EvalIndividualResult[],
  totalEvals: number,
  evalStartTime: number,
): void {
  const totalDuration = ((Date.now() - evalStartTime) / 1000).toFixed(1);
  const status = result.passed ? "PASS" : "FAIL";
  const reason = result.passed ? "" : ` (${result.failure_reason})`;
  const completed = allResults.length;
  const passedCount = allResults.filter((r) => r.passed).length;
  const failedCount = completed - passedCount;
  const pct = ((completed / totalEvals) * 100).toFixed(0);

  logInfo(
    `[${evalPathStr}] ${status}${reason} (${totalDuration}s) | Progress: ${completed}/${totalEvals} (${pct}%) - ${passedCount} passed, ${failedCount} failed`,
  );
}

// ── Run (only when executed directly, not when imported) ──────────────

// Bun sets import.meta.main to true when the file is the entrypoint.
// We also check process.argv as a fallback for other runtimes.
const isMain =
  (import.meta as { main?: boolean }).main === true ||
  process.argv[1]?.replace(/\\/g, "/").endsWith("runner/index.ts") ||
  process.argv[1]?.replace(/\\/g, "/").endsWith("runner/index.js");

if (isMain) {
  main().catch((e) => {
    // InfrastructureError already prints its message before throwing, so skip
    // the double-print here.
    if (!(e instanceof InfrastructureError)) {
      console.error(e);
    }
    process.exit(1);
  });
}
