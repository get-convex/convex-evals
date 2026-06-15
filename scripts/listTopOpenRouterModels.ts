#!/usr/bin/env bun
/**
 * Output top OpenRouter models as JSON for use in CI workflows.
 * We fetch OpenRouter's top weekly ordering, take the first N unique model
 * slugs, then keep only the models that are due according to the shared model
 * scheduling policy and still look runnable on OpenRouter.
 *
 * Usage:
 *   bun run scripts/listTopOpenRouterModels.ts --limit 15 --format json
 */
import { ConvexHttpClient } from "convex/browser";
import { ALL_MODELS } from "../runner/models/index.js";
import {
  getTextOutputEvalIncompatibilityReason,
  resolveModel,
  preflightOpenRouterEndpoint,
} from "../runner/models/openRouterDiscovery.js";
import { loadSchedulingDecisions } from "./modelScheduling.js";

const OPENROUTER_TOP_MODELS_URL =
  "https://openrouter.ai/api/v1/models?sort=top-weekly";
const DEFAULT_LIMIT = 15;

export interface TopOpenRouterSelectorOptions {
  limit?: number;
  excludeKnownModels?: boolean;
  dueOnly?: boolean;
  runnableOnly?: boolean;
}

interface OpenRouterModel {
  id?: string;
}

interface OpenRouterModelsResponse {
  data?: OpenRouterModel[];
}

export function shouldSkipForProviderError(error: unknown): boolean {
  const message = String(error);
  return message.includes("400 Bad Request: Provider returned error");
}

export function shouldSkipForMissingEndpoint(error: unknown): boolean {
  const message = String(error);
  return (
    message.includes("404 Not Found: No endpoints found") ||
    message.includes("No endpoints found for")
  );
}

function parseArgs(): { limit: number; format: string } {
  const args = process.argv.slice(2);
  let limit = DEFAULT_LIMIT;
  let format = "json";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--limit" && args[i + 1]) {
      const parsed = Number.parseInt(args[++i], 10);
      if (!Number.isNaN(parsed) && parsed > 0) {
        limit = parsed;
      }
    }
    if (args[i] === "--format" && args[i + 1]) {
      format = args[++i];
    }
  }

  return { limit, format };
}

export async function fetchTopDailySlugs(): Promise<string[]> {
  const response = await fetch(OPENROUTER_TOP_MODELS_URL, {
    headers: {
      Accept: "application/json",
      "User-Agent": "convex-evals-ci/1.0",
    },
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch OpenRouter top weekly models: ${response.status} ${response.statusText}`,
    );
  }

  const payload = (await response.json()) as OpenRouterModelsResponse;
  const models = payload.data;

  if (!Array.isArray(models)) {
    throw new Error("Unexpected OpenRouter response shape (missing data)");
  }

  return models
    .map((model) => model.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
}

export function selectTopModels(slugs: string[], limit: number): string[] {
  const selected: string[] = [];

  for (const slug of slugs) {
    if (selected.includes(slug)) continue;
    selected.push(slug);
    if (selected.length >= limit) break;
  }

  return selected;
}

async function filterDueModels(models: string[]): Promise<string[]> {
  const convexUrl = process.env.CONVEX_EVAL_URL;
  if (!convexUrl) {
    console.error(
      "CONVEX_EVAL_URL not set, returning top models without recency filtering",
    );
    return models;
  }

  const client = new ConvexHttpClient(convexUrl);
  const schedulingDecisions = await loadSchedulingDecisions(client, models);

  return models.filter((model) => {
    return schedulingDecisions.get(model)?.isDue ?? true;
  });
}

async function filterRunnableModels(models: string[]): Promise<string[]> {
  const openRouterApiKey = process.env.OPENROUTER_API_KEY;
  if (!openRouterApiKey) {
    console.error(
      "OPENROUTER_API_KEY not set, returning top models without preflight filtering",
    );
    return models;
  }

  const settled = await Promise.all(
    models.map(async (modelName) => {
      try {
        const resolved = await resolveModel(modelName);
        if (!resolved.discovered) {
          console.error(`Skipping ${modelName}: not discoverable on OpenRouter`);
          return null;
        }
        const incompatibilityReason =
          getTextOutputEvalIncompatibilityReason(resolved);
        if (incompatibilityReason) {
          console.error(`Skipping ${modelName}: ${incompatibilityReason}`);
          return null;
        }
        await preflightOpenRouterEndpoint(resolved.model, openRouterApiKey);
        return modelName;
      } catch (error) {
        if (
          shouldSkipForMissingEndpoint(error) ||
          shouldSkipForProviderError(error)
        ) {
          console.error(`Skipping ${modelName}: ${String(error)}`);
          return null;
        }
        console.error(`Skipping ${modelName}: ${String(error)}`);
        return null;
      }
    }),
  );

  return settled.filter((modelName): modelName is string => modelName !== null);
}

export async function selectTopOpenRouterModels(
  options: TopOpenRouterSelectorOptions = {},
): Promise<string[]> {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const excludeKnownModels = options.excludeKnownModels ?? true;
  const dueOnly = options.dueOnly ?? true;
  const runnableOnly = options.runnableOnly ?? true;
  const topSlugs = await fetchTopDailySlugs();
  const topModels = selectTopModels(topSlugs, limit);
  const knownModels = new Set(ALL_MODELS);
  const candidateModels = excludeKnownModels
    ? topModels.filter((model) => !knownModels.has(model))
    : topModels;
  const dueModels = dueOnly
    ? await filterDueModels(candidateModels)
    : candidateModels;
  return runnableOnly ? filterRunnableModels(dueModels) : dueModels;
}

export async function main(): Promise<void> {
  const { limit, format } = parseArgs();
  const models = await selectTopOpenRouterModels({ limit });

  if (format === "json") {
    console.log(JSON.stringify(models));
  } else {
    console.log(models.join(","));
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
