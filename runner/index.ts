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
import { config } from "dotenv";

import {
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
import { Model } from "./models/modelCodegen.js";
import { convexScorer, walkAnswer } from "./scorer.js";
import { InfrastructureError, RateLimitAbortError } from "./convexBackend.js";
import {
  ensureModelFromSlug,
  startRun,
  completeRun,
  deleteRunRecord,
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

const DEFAULT_MODEL_NAMES = [
  "claude-3-5-sonnet-latest",
  "claude-3-7-sonnet-latest",
  "claude-sonnet-4-0",
  "claude-sonnet-4-5",
  "claude-haiku-4-5",
  "claude-opus-4-5",
  "gpt-4o",
  "o3-mini",
  "gemini-2.0-flash-lite",
  "meta-llama/Meta-Llama-3.1-405B-Instruct-Turbo",
  "gemini-3.1-pro-preview",
  "grok-3-mini-beta",
];

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

// ── Main (CLI entrypoint) ─────────────────────────────────────────────

async function main(): Promise<void> {
  const executionMode = parseExecutionMode(process.env.EVALS_EXECUTION_MODE);
  const modelNames = process.env.MODELS
    ? process.env.MODELS.split(",").map((s) => s.trim()).filter(Boolean)
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
      console.error(`Model ${modelName} not supported and not found on OpenRouter`);
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
  const {
    model,
    provider = "openrouter",
    tempdir,
    testFilter,
    executionMode = "generate",
    convexEvalUrl,
    convexAuthToken,
  } =
    config;
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
      const plannedEvals = filteredPaths.map(
        (e) => `${e.category}/${e.name}`,
      );
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
    let openRouterApiKey: string | null = null;
    if (executionMode === "generate") {
      const apiKeyVar = OPENROUTER_API_KEY_VAR;
      const apiKey = process.env[apiKeyVar];
      if (!apiKey) {
        console.error(`${apiKeyVar} is not set`);
        process.exit(1);
      }
      openRouterApiKey = apiKey;
    }

    if (executionMode === "generate" && openRouterApiKey) {
      logInfo(`[preflight] Checking endpoint availability for ${model.name}...`);
      try {
        await preflightOpenRouterEndpoint(model, openRouterApiKey);
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
      modelImpl = new Model(openRouterApiKey, model);
    }

    const allResults: EvalIndividualResult[] = [];
    let rateLimitCount = 0;
    const RATE_LIMIT_ABORT_THRESHOLD = 3;

    // Process evals with concurrency control
    const queue = [...filteredPaths];
    const inFlight = new Set<Promise<void>>();

    try {
      while (queue.length > 0 || inFlight.size > 0) {
        // Abort early if we've hit too many rate-limit errors
        if (rateLimitCount >= RATE_LIMIT_ABORT_THRESHOLD) {
          // Drain remaining queue — don't start new evals
          if (queue.length > 0) {
            logInfo(
              `Aborting run: ${rateLimitCount} rate-limit errors exceeded threshold (${RATE_LIMIT_ABORT_THRESHOLD}). Skipping ${queue.length} remaining eval(s).`,
            );
            queue.length = 0;
          }
          // Wait for in-flight evals to finish, but don't start new ones
          if (inFlight.size > 0) {
            await Promise.race(inFlight);
            continue;
          }
          break;
        }

        while (queue.length > 0 && inFlight.size < DEFAULT_MAX_CONCURRENCY) {
          const evalInfo = queue.shift()!;
          const promise = processOneEval(
            model,
            modelImpl,
            executionMode,
            evalInfo,
            runId,
            allResults,
            filteredPaths.length,
            tempdir,
          ).then((wasRateLimited) => {
            if (wasRateLimited) rateLimitCount++;
          }).finally(() => inFlight.delete(promise));
          inFlight.add(promise);
        }
        if (inFlight.size > 0) {
          await Promise.race(inFlight);
        }
      }
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
    // This is treated as corrupted telemetry and should not be stored.
    if (executionMode === "generate" && runId) {
      const zeroTokenEval = allResults.find((result) =>
        hasZeroTotalTokens(result.usage),
      );
      if (zeroTokenEval) {
        const evalPath = `${zeroTokenEval.category}/${zeroTokenEval.name}`;
        const reason = `[infrastructure] [zero_tokens] Zero total token usage detected for ${evalPath}`;
        console.error(`Run invalid, deleting ${runId}: ${reason}`);
        const deleted = await deleteRunRecord(runId);
        if (deleted) {
          logInfo(`Deleted run ${runId} due to zero-token eval usage`);
        } else {
          logInfo(
            `Failed to delete run ${runId} after zero-token eval usage detected`,
          );
        }
        runId = null;
        throw new InfrastructureError(reason);
      }
    }

    // Print summary
    printEvalSummary(modelDisplayName, allResults);

    if (executionMode === "answer" && allResults.some((result) => !result.passed)) {
      const reason = "[answer_validation] Canonical answers must pass all evals";
      if (runId) {
        await completeRun(runId, {
          kind: "failed",
          failureReason: reason,
          durationMs: Date.now() - runStartTime,
        });
      }
      throw new Error(reason);
    }

    // If we aborted due to rate limits, fail the run so it doesn't
    // appear on the leaderboard with partial (misleading) results.
    if (rateLimitCount >= RATE_LIMIT_ABORT_THRESHOLD) {
      const reason = `[rate_limit] Aborted after ${rateLimitCount} rate-limit errors`;
      if (runId) {
        await completeRun(runId, {
          kind: "failed",
          failureReason: reason,
          durationMs: Date.now() - runStartTime,
        });
      }
      console.error(`Run failed: aborted after ${rateLimitCount} rate-limit errors (threshold: ${RATE_LIMIT_ABORT_THRESHOLD})`);
      throw new RateLimitAbortError(reason);
    }

    // Complete run
    if (runId) {
      const runUsage: LanguageModelUsage = {
        inputTokens: 0,
        inputTokenDetails: { noCacheTokens: undefined, cacheReadTokens: undefined, cacheWriteTokens: undefined },
        outputTokens: 0,
        outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
        totalTokens: 0,
      };
      for (const r of allResults) {
        if (r.usage) {
          if (typeof r.usage.inputTokens === "number") runUsage.inputTokens = (runUsage.inputTokens ?? 0) + r.usage.inputTokens;
          if (typeof r.usage.outputTokens === "number") runUsage.outputTokens = (runUsage.outputTokens ?? 0) + r.usage.outputTokens;
          if (typeof r.usage.totalTokens === "number") runUsage.totalTokens = (runUsage.totalTokens ?? 0) + r.usage.totalTokens;
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

const RATE_LIMIT_MAX_RETRIES = 2; // 3 total attempts
const RATE_LIMIT_RETRY_BASE_MS = 30_000; // 30s, then 60s

/** Process a single eval. Returns `true` if the failure was a rate-limit error. */
async function processOneEval(
  model: ResolvedModel,
  modelImpl: Model | null,
  executionMode: ExecutionMode,
  evalInfo: EvalInfo,
  runId: string | null,
  allResults: EvalIndividualResult[],
  totalEvals: number,
  tempdir: string,
): Promise<boolean> {
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
    return false;
  }

  if (modelImpl === null) {
    throw new Error(`Model implementation missing for mode: ${executionMode}`);
  }

  // Attempt to generate with retries on rate-limit errors.
  let generateResult: {
    files: Record<string, string>;
    usage: LanguageModelUsage | undefined;
    rawResponse: string;
  } | null = null;
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= RATE_LIMIT_MAX_RETRIES; attempt++) {
    try {
      const { files, usage, rawResponse } =
        await modelImpl.generate(taskDescription);
      generateResult = { files, usage, rawResponse };
      break;
    } catch (e) {
      // Infrastructure failures always abort immediately - no retry.
      if (e instanceof InfrastructureError) throw e;

      lastError = e;
      const errorStr = String(e);

      if (isRateLimitError(errorStr) && attempt < RATE_LIMIT_MAX_RETRIES) {
        const delayMs = RATE_LIMIT_RETRY_BASE_MS * Math.pow(2, attempt);
        logInfo(
          `[${evalPathStr}] Rate limited, retrying in ${delayMs / 1000}s (attempt ${attempt + 1}/${RATE_LIMIT_MAX_RETRIES})...`,
        );
        await new Promise((r) => setTimeout(r, delayMs));
      }
      // Non-rate-limit errors, or retries exhausted - fall through to error handling.
    }
  }

  if (generateResult !== null) {
    const { files: output, usage, rawResponse } = generateResult;

    if (usage) {
      metadata.usage = usage;
    }
    if (Object.keys(output).length === 0) {
      metadata.raw_model_response_debug = truncateRawModelResponse(rawResponse);
      metadata.raw_model_response_length = rawResponse.length;
    }

    const generateDuration = ((Date.now() - evalStartTime) / 1000).toFixed(1);
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

    const result = buildEvalResult(category, name, model.name, scores, tempdir, usage);
    allResults.push(result);
    logProgress(evalPathStr, result, allResults, totalEvals, evalStartTime);
    return false;
  }

  // Generation failed after all attempts.
  const errorStr = String(lastError);
  const rateLimited = isRateLimitError(errorStr);
  const prefix = rateLimited ? "[rate_limit] " : "";
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
  // Rate-limit failures are tagged with [rate_limit] so the leaderboard
  // can exclude them from scoring (they reflect infrastructure limits,
  // not model quality).
  if (evalId) {
    await completeEval(evalId, {
      kind: "failed",
      failureReason: `${prefix}error: ${errorStr}`,
      durationMs: Date.now() - evalStartTime,
      usage: undefined,
    });
  }

  logProgress(
    evalPathStr,
    allResults[allResults.length - 1],
    allResults,
    totalEvals,
    evalStartTime,
  );

  return rateLimited;
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
    // InfrastructureError and RateLimitAbortError already print their message
    // before throwing, so skip the double-print here.
    if (!(e instanceof InfrastructureError) && !(e instanceof RateLimitAbortError)) {
      console.error(e);
    }
    process.exit(1);
  });
}
