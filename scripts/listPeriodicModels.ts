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
import { ConvexHttpClient } from "convex/browser";
import { writeFile } from "node:fs/promises";
import { ALL_MODELS } from "../runner/models/index.js";
import {
  discoverOpenRouterModel,
  preflightOpenRouterEndpoint,
} from "../runner/models/openRouterDiscovery.js";
import {
  fetchAgenticBenchmarkRows,
  selectTopModels as selectTopBenchmarkModels,
} from "./listTopOpenRouterBenchmarkModels.js";
import {
  fetchTopDailySlugs,
  shouldKeepDespitePreflightFailure,
  shouldSkipForMissingEndpoint,
} from "./listTopOpenRouterModels.js";
import {
  loadSchedulingDecisions,
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
  if (decision.lastRunTime === null) {
    return `never run before, target interval ${formatDuration(decision.targetIntervalMs)}`;
  }

  const elapsedMs = Math.max(0, now - decision.lastRunTime);
  const remainingMs = Math.max(0, decision.targetIntervalMs - elapsedMs);
  return decision.isDue
    ? `last run ${formatDuration(elapsedMs)} ago, target interval ${formatDuration(decision.targetIntervalMs)}`
    : `last run ${formatDuration(elapsedMs)} ago, target interval ${formatDuration(decision.targetIntervalMs)}, due in ${formatDuration(remainingMs)}`;
}

function requiresSelectorPreflight(sources: ModelSourceName[]): boolean {
  return sources.some((source) => source !== "curated");
}

function shouldRetryPreflightFailure(error: unknown): boolean {
  return !shouldSkipForMissingEndpoint(error) &&
    !shouldKeepDespitePreflightFailure(error);
}

async function collectCuratedModels(): Promise<string[]> {
  const models = ALL_MODELS.map((model) => model.name);
  console.log(`[periodic] curated source produced ${models.length} models`);
  return models;
}

async function collectTopDayModels(): Promise<string[]> {
  console.log(
    `[periodic] fetching top-day OpenRouter models, target ${TOP_DAY_LIMIT}`,
  );
  const knownModels = new Set(ALL_MODELS.map((model) => model.name));
  const topSlugs = await fetchTopDailySlugs();
  const selected: string[] = [];

  for (const slug of topSlugs) {
    if (knownModels.has(slug)) {
      console.log(
        `[periodic] [top-day] skipping ${slug}: already covered by curated models`,
      );
      continue;
    }

    if (selected.includes(slug)) {
      console.log(`[periodic] [top-day] skipping duplicate ${slug}`);
      continue;
    }

    selected.push(slug);
    console.log(
      `[periodic] [top-day] selected ${slug} (${selected.length}/${TOP_DAY_LIMIT})`,
    );
    if (selected.length >= TOP_DAY_LIMIT) break;
  }

  console.log(`[periodic] top-day source produced ${selected.length} models`);
  return selected;
}

async function collectBenchmarkModels(): Promise<string[]> {
  console.log(
    `[periodic] fetching benchmark OpenRouter models, target ${BENCHMARK_LIMIT}`,
  );
  const rows = await fetchAgenticBenchmarkRows();
  const models = selectTopBenchmarkModels(rows, BENCHMARK_LIMIT);
  console.log(`[periodic] benchmark source produced ${models.length} models`);
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

  console.log(
    `Periodic selector counts: ${sourceEntries
      .map(([name, sourceModels]) => `${name}=${sourceModels.length}`)
      .join(", ")}`,
  );
  console.log(
    `Periodic selector merged ${totalCandidates} candidates into ${merged.models.length} unique models`,
  );
  if (overlaps.length > 0) {
    console.log(
      `Periodic selector overlaps: ${overlaps
        .map(([model, sources]) => `${model} (${sources.join(", ")})`)
        .join("; ")}`,
    );
  }
}

async function filterDueModelsSequentially(models: string[]): Promise<string[]> {
  const convexUrl = process.env.CONVEX_EVAL_URL;
  if (!convexUrl) {
    console.log(
      "[periodic] CONVEX_EVAL_URL not set, returning models without due filtering",
    );
    return models;
  }

  const now = Date.now();
  const client = new ConvexHttpClient(convexUrl);
  const schedulingDecisions = await loadSchedulingDecisions(client, models, now);
  const dueModels: string[] = [];

  for (const model of models) {
    const decision = schedulingDecisions.get(model);
    if (!decision) {
      console.log(
        `[periodic] [due] keeping ${model}: missing scheduling metadata`,
      );
      dueModels.push(model);
      continue;
    }

    if (decision.isDue) {
      console.log(
        `[periodic] [due] keeping ${model}: ${describeDecision(decision, now)}`,
      );
      dueModels.push(model);
      continue;
    }

    console.log(
      `[periodic] [due] skipping ${model}: ${describeDecision(decision, now)}`,
    );
  }

  console.log(
    `[periodic] due filter kept ${dueModels.length}/${models.length} models`,
  );
  return dueModels;
}

async function preflightWithRetries(
  modelName: string,
  apiKey: string,
): Promise<{
  success: boolean;
  error?: unknown;
  attempts: number;
}> {
  const discovered = await discoverOpenRouterModel(modelName);
  if (!discovered) {
    return {
      success: false,
      error: new Error(`Model ${modelName} is not discoverable on OpenRouter`),
      attempts: 1,
    };
  }

  let lastError: unknown;
  let attempts = 0;
  for (let attempt = 1; attempt <= PREFLIGHT_MAX_ATTEMPTS; attempt++) {
    attempts = attempt;
    console.log(
      `[periodic] [preflight] attempt ${attempt}/${PREFLIGHT_MAX_ATTEMPTS} for ${modelName}`,
    );
    try {
      await preflightOpenRouterEndpoint(discovered.template, apiKey);
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
      console.log(
        `[periodic] [preflight] retrying ${modelName} after attempt ${attempt} failed: ${String(error)}`,
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
    console.log(
      "[periodic] OPENROUTER_API_KEY not set, returning models without selector preflight filtering",
    );
    return models;
  }

  const runnableModels: string[] = [];
  for (const model of models) {
    const sources = modelSources[model] ?? [];
    if (!requiresSelectorPreflight(sources)) {
      console.log(
        `[periodic] [preflight] keeping ${model} without selector preflight: curated-only model`,
      );
      runnableModels.push(model);
      continue;
    }

    const result = await preflightWithRetries(model, openRouterApiKey);
    if (result.success) {
      console.log(
        `[periodic] [preflight] keeping ${model}: passed after ${result.attempts} attempt${result.attempts === 1 ? "" : "s"}`,
      );
      runnableModels.push(model);
      continue;
    }

    const errorMessage = String(result.error);
    if (shouldKeepDespitePreflightFailure(result.error)) {
      console.log(
        `[periodic] [preflight] keeping ${model} despite provider error after ${result.attempts} attempt${result.attempts === 1 ? "" : "s"}: ${errorMessage}`,
      );
      runnableModels.push(model);
      continue;
    }

    console.log(
      `[periodic] [preflight] skipping ${model} after ${result.attempts} attempt${result.attempts === 1 ? "" : "s"}: ${errorMessage}`,
    );
  }

  console.log(
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

  const dueModels = await filterDueModelsSequentially(merged.models);
  const runnableModels = await filterRunnableModelsSequentially(
    dueModels,
    merged.modelSources,
  );

  console.log(
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
    console.log(`[periodic] wrote output to ${outputFile}`);
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
