import { ConvexHttpClient } from "convex/browser";
import { api } from "../evalScores/convex/_generated/api.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_INTERVAL_MS = DAY_MS;
const MAX_INTERVAL_MS = 30 * DAY_MS;
const RAMP_WINDOW_MS = 30 * DAY_MS;
const LIST_MODELS_BATCH_SIZE = 10;

export interface SchedulingDecision {
  isDue: boolean;
  lastRunTime: number | null;
  openRouterFirstSeenAt: number | null;
  targetIntervalMs: number;
}

export interface SchedulingMetadata {
  decision: SchedulingDecision;
  modelExists: boolean;
}

function chunk<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < values.length; i += size) {
    chunks.push(values.slice(i, i + size));
  }
  return chunks;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function computeTargetIntervalMs(
  openRouterFirstSeenAt: number | null,
  now = Date.now(),
): number {
  if (openRouterFirstSeenAt === null) {
    return MIN_INTERVAL_MS;
  }

  const ageMs = clamp(now - openRouterFirstSeenAt, 0, RAMP_WINDOW_MS);
  const ageRatio = ageMs / RAMP_WINDOW_MS;
  return MIN_INTERVAL_MS + ageRatio * (MAX_INTERVAL_MS - MIN_INTERVAL_MS);
}

export function getSchedulingDecision(
  lastRunTime: number | null,
  openRouterFirstSeenAt: number | null,
  now = Date.now(),
): SchedulingDecision {
  const targetIntervalMs = computeTargetIntervalMs(openRouterFirstSeenAt, now);
  return {
    isDue: lastRunTime === null || now - lastRunTime >= targetIntervalMs,
    lastRunTime,
    openRouterFirstSeenAt,
    targetIntervalMs,
  };
}

export async function loadSchedulingDecisions(
  client: ConvexHttpClient,
  slugs: string[],
  now = Date.now(),
): Promise<Map<string, SchedulingDecision>> {
  const metadata = await loadSchedulingMetadata(client, slugs, now);
  return new Map(
    Array.from(metadata.entries()).map(([slug, value]) => [slug, value.decision]),
  );
}

export async function loadSchedulingMetadata(
  client: ConvexHttpClient,
  slugs: string[],
  now = Date.now(),
): Promise<Map<string, SchedulingMetadata>> {
  const uniqueSlugs = [...new Set(slugs)];
  const modelDocs = await Promise.all(
    uniqueSlugs.map((slug) => client.query(api.models.getBySlug, { slug })),
  );
  const existingModelIds = modelDocs
    .filter((modelDoc) => modelDoc !== null)
    .map((modelDoc) => modelDoc._id);
  const modelSummaryBatches = await Promise.all(
    chunk(existingModelIds, LIST_MODELS_BATCH_SIZE).map((modelIds) =>
      client.query(api.runs.listModels, { modelIds }),
    ),
  );
  const modelSummaries = modelSummaryBatches.flat();

  return new Map(
    uniqueSlugs.map((slug, index) => {
      const modelDoc = modelDocs[index];
      const latestRun =
        modelSummaries.find((entry) => entry.slug === slug)?.latestRun ?? null;
      return [
        slug,
        {
          decision: getSchedulingDecision(
            latestRun,
            modelDoc?.openRouterFirstSeenAt ?? null,
            now,
          ),
          modelExists: modelDoc !== null,
        },
      ] as const;
    }),
  );
}
