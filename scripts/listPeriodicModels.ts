#!/usr/bin/env bun
/**
 * Output periodic workflow models as JSON for use in CI workflows.
 * We gather raw candidates from curated, top-day OpenRouter, and benchmark
 * sources, dedupe once, then apply due and selector preflight filters with
 * detailed logging so it is obvious why each model was kept or skipped.
 *
 * Usage:
 *   bun run scripts/listPeriodicModels.ts --format json [--output-file <path>]
 */
import "dotenv/config";
import chalk from "chalk";
import { ConvexHttpClient } from "convex/browser";
import { writeFile } from "node:fs/promises";
import { ALL_MODELS } from "../runner/models/index.js";
import {
  getTextOutputEvalIncompatibilityReason,
  resolveModel,
  preflightOpenRouterEndpoint,
} from "../runner/models/openRouterDiscovery.js";
import type { ResolvedModel } from "../runner/models/index.js";
import {
  fetchAgenticBenchmarkRows,
  selectTopModels as selectTopBenchmarkModels,
} from "./listTopOpenRouterBenchmarkModels.js";
import {
  fetchTopDailySlugs,
  shouldSkipForProviderError,
  shouldSkipForMissingEndpoint,
} from "./listTopOpenRouterModels.js";
import {
  loadSchedulingMetadata,
  type SchedulingMetadata,
  type SchedulingDecision,
} from "./modelScheduling.js";

const DEFAULT_FORMAT = "json";
const TOP_DAY_LIMIT = 15;
const BENCHMARK_LIMIT = 10;
const PREFLIGHT_MAX_ATTEMPTS = 3;
const PREFLIGHT_RETRY_DELAYS_MS = [1_000, 2_000];

type ModelSourceName = "curated" | "top-day" | "benchmark";

export interface MergeModelsResult {
  models: string[];
  modelSources: Record<string, ModelSourceName[]>;
}

function parseArgs(): { format: string; outputFile?: string } {
  const args = process.argv.slice(2);
  let format = DEFAULT_FORMAT;
  let outputFile: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--format" && args[i + 1]) {
      format = args[++i];
    }
    if (args[i] === "--output-file" && args[i + 1]) {
      outputFile = args[++i];
    }
  }

  return { format, outputFile };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function logInfo(message: string): void {
  console.log(chalk.cyan(message));
}

function logSuccess(message: string): void {
  console.log(chalk.green(message));
}

function logWarning(message: string): void {
  console.log(chalk.yellow(message));
}

function logError(message: string): void {
  console.error(chalk.red(message));
}

function logSummary(message: string): void {
  console.log(chalk.bold(message));
}

function formatDuration(ms: number): string {
  const totalMinutes = Math.max(0, Math.ceil(ms / 60_000));
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0 || parts.length === 0) parts.push(`${minutes}m`);
  return parts.join(" ");
}

function describeDecision(decision: SchedulingDecision, now: number): string {
  const costSuffix =
    decision.averageRunCostUsd !== null
      ? `, average run cost $${decision.averageRunCostUsd.toFixed(2)}`
      : "";

  if (decision.lastRunTime === null) {
    return `never run before, target interval ${formatDuration(decision.targetIntervalMs)}${costSuffix}`;
  }

  const elapsedMs = Math.max(0, now - decision.lastRunTime);
  const remainingMs = Math.max(0, decision.targetIntervalMs - elapsedMs);
  return decision.isDue
    ? `last run ${formatDuration(elapsedMs)} ago, target interval ${formatDuration(decision.targetIntervalMs)}${costSuffix}`
    : `last run ${formatDuration(elapsedMs)} ago, target interval ${formatDuration(decision.targetIntervalMs)}, due in ${formatDuration(remainingMs)}${costSuffix}`;
}

function shouldRetryPreflightFailure(error: unknown): boolean {
  return !shouldSkipForMissingEndpoint(error) &&
    !shouldSkipForProviderError(error);
}

async function collectCuratedModels(): Promise<string[]> {
  const models = [...ALL_MODELS];
  logInfo(`[periodic] curated source produced ${models.length} models`);
  return models;
}

async function collectTopDayModels(): Promise<string[]> {
  logInfo(
    `[periodic] fetching top-day OpenRouter models, target ${TOP_DAY_LIMIT}`,
  );
  const knownModels = new Set(ALL_MODELS);
  const topSlugs = await fetchTopDailySlugs();
  const selected: string[] = [];

  for (const slug of topSlugs) {
    if (knownModels.has(slug)) {
      logWarning(
        `[periodic] [top-day] skipping ${slug}: already covered by curated models`,
      );
      continue;
    }

    if (selected.includes(slug)) {
      logWarning(`[periodic] [top-day] skipping duplicate ${slug}`);
      continue;
    }

    selected.push(slug);
    logSuccess(
      `[periodic] [top-day] selected ${slug} (${selected.length}/${TOP_DAY_LIMIT})`,
    );
    if (selected.length >= TOP_DAY_LIMIT) break;
  }

  logInfo(`[periodic] top-day source produced ${selected.length} models`);
  return selected;
}

async function collectBenchmarkModels(): Promise<string[]> {
  logInfo(
    `[periodic] fetching benchmark OpenRouter models, target ${BENCHMARK_LIMIT}`,
  );
  const rows = await fetchAgenticBenchmarkRows();
  const models = selectTopBenchmarkModels(rows, BENCHMARK_LIMIT);
  logInfo(`[periodic] benchmark source produced ${models.length} models`);
  return models;
}

export function mergeModelSources(
  sourceEntries: Array<[ModelSourceName, string[]]>,
): MergeModelsResult {
  const models: string[] = [];
  const modelSources = new Map<string, ModelSourceName[]>();

  for (const [sourceName, sourceModels] of sourceEntries) {
    for (const model of sourceModels) {
      const existingSources = modelSources.get(model);
      if (existingSources) {
        existingSources.push(sourceName);
        continue;
      }

      modelSources.set(model, [sourceName]);
      models.push(model);
    }
  }

  return {
    models,
    modelSources: Object.fromEntries(modelSources),
  };
}

function logSelectionSummary(
  sourceEntries: Array<[ModelSourceName, string[]]>,
  merged: MergeModelsResult,
): void {
  const totalCandidates = sourceEntries.reduce(
    (sum, [, sourceModels]) => sum + sourceModels.length,
    0,
  );
  const overlaps = Object.entries(merged.modelSources).filter(
    ([, sources]) => sources.length > 1,
  );

  logSummary(
    `Periodic selector counts: ${sourceEntries
      .map(([name, sourceModels]) => `${name}=${sourceModels.length}`)
      .join(", ")}`,
  );
  logSummary(
    `Periodic selector merged ${totalCandidates} candidates into ${merged.models.length} unique models`,
  );
  if (overlaps.length > 0) {
    logSummary(
      `Periodic selector overlaps: ${overlaps
        .map(([model, sources]) => `${model} (${sources.join(", ")})`)
        .join("; ")}`,
    );
  }
}

function filterDueModelsSequentially(
  models: string[],
  schedulingMetadata: Map<string, SchedulingMetadata> | null,
): string[] {
  if (!schedulingMetadata) return models;
  const now = Date.now();
  const dueModels: string[] = [];

  for (const model of models) {
    const metadata = schedulingMetadata.get(model);
    if (!metadata) {
      logWarning(
        `[periodic] [due] keeping ${model}: missing scheduling metadata`,
      );
      dueModels.push(model);
      continue;
    }

    const decision = metadata.decision;
    if (decision.isDue) {
      logSuccess(
        `[periodic] [due] keeping ${model}: ${describeDecision(decision, now)}`,
      );
      dueModels.push(model);
      continue;
    }

    logWarning(
      `[periodic] [due] skipping ${model}: ${describeDecision(decision, now)}`,
    );
  }

  logInfo(
    `[periodic] due filter kept ${dueModels.length}/${models.length} models`,
  );
  return dueModels;
}

async function preflightWithRetries(
  model: ResolvedModel,
  apiKey: string,
): Promise<{
  success: boolean;
  error?: unknown;
  attempts: number;
}> {
  let lastError: unknown;
  let attempts = 0;
  for (let attempt = 1; attempt <= PREFLIGHT_MAX_ATTEMPTS; attempt++) {
    attempts = attempt;
    logInfo(
      `[periodic] [preflight] attempt ${attempt}/${PREFLIGHT_MAX_ATTEMPTS} for ${model.name}`,
    );
    try {
      await preflightOpenRouterEndpoint(model, apiKey);
      return { success: true, attempts: attempt };
    } catch (error) {
      lastError = error;
      if (
        attempt >= PREFLIGHT_MAX_ATTEMPTS ||
        !shouldRetryPreflightFailure(error)
      ) {
        break;
      }

      const delayMs = PREFLIGHT_RETRY_DELAYS_MS[attempt - 1] ?? 2_000;
      logError(
        `[periodic] [preflight] retrying ${model.name} after attempt ${attempt} failed: ${String(error)}`,
      );
      await sleep(delayMs);
    }
  }

  return {
    success: false,
    error: lastError,
    attempts,
  };
}

async function filterRunnableModelsSequentially(
  models: string[],
  modelSources: Record<string, ModelSourceName[]>,
): Promise<string[]> {
  const openRouterApiKey = process.env.OPENROUTER_API_KEY;
  if (!openRouterApiKey) {
    logWarning(
      "[periodic] OPENROUTER_API_KEY not set, returning models without selector preflight filtering",
    );
    return models;
  }

  const runnableModels: string[] = [];
  for (const model of models) {
    const sources = modelSources[model] ?? [];
    const resolved = await resolveModel(model);
    if (!resolved.discovered) {
      logError(
        `[periodic] [preflight] skipping ${model}: not discoverable on OpenRouter`,
      );
      continue;
    }

    const incompatibilityReason = getTextOutputEvalIncompatibilityReason(resolved);
    if (incompatibilityReason) {
      logError(
        `[periodic] [preflight] skipping ${model}: ${incompatibilityReason}`,
      );
      continue;
    }

    const result = await preflightWithRetries(resolved.model, openRouterApiKey);
    if (result.success) {
      logSuccess(
        `[periodic] [preflight] keeping ${model}: passed after ${result.attempts} attempt${result.attempts === 1 ? "" : "s"} (${sources.join(", ") || "unknown source"})`,
      );
      runnableModels.push(model);
      continue;
    }

    const errorMessage = String(result.error);
    logError(
      `[periodic] [preflight] skipping ${model} after ${result.attempts} attempt${result.attempts === 1 ? "" : "s"}: ${errorMessage}`,
    );
  }

  logInfo(
    `[periodic] runnable filter kept ${runnableModels.length}/${models.length} models`,
  );
  return runnableModels;
}

export async function selectPeriodicModels(): Promise<string[]> {
  const curatedModels = await collectCuratedModels();
  const topOpenRouterModels = await collectTopDayModels();
  const benchmarkModels = await collectBenchmarkModels();

  const sourceEntries: Array<[ModelSourceName, string[]]> = [
    ["curated", curatedModels],
    ["top-day", topOpenRouterModels],
    ["benchmark", benchmarkModels],
  ];
  const merged = mergeModelSources(sourceEntries);

  logSelectionSummary(sourceEntries, merged);

  const convexUrl = process.env.CONVEX_EVAL_URL;
  const schedulingMetadata = convexUrl
    ? await loadSchedulingMetadata(
        new ConvexHttpClient(convexUrl),
        merged.models,
      )
    : null;
  if (!schedulingMetadata) {
    logWarning(
      "[periodic] CONVEX_EVAL_URL not set, returning models without due filtering",
    );
  }

  const dueModels = filterDueModelsSequentially(merged.models, schedulingMetadata);
  const runnableModels = await filterRunnableModelsSequentially(
    dueModels,
    merged.modelSources,
  );

  logSummary(
    `[periodic] final selection contains ${runnableModels.length} models`,
  );
  return runnableModels;
}

export async function main(): Promise<void> {
  const { format, outputFile } = parseArgs();
  const models = await selectPeriodicModels();
  const serializedModels =
    format === "json" ? JSON.stringify(models) : models.join(",");

  if (outputFile) {
    await writeFile(outputFile, serializedModels, "utf8");
    logInfo(`[periodic] wrote output to ${outputFile}`);
  } else {
    console.log(serializedModels);
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
