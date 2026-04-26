import { ConvexHttpClient } from "convex/browser";
import { api } from "../evalScores/convex/_generated/api.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_INTERVAL_MS = DAY_MS;
const MAX_INTERVAL_MS = 60 * DAY_MS;
const COST_BIAS_START_USD = 5;
const COST_BIAS_FULL_USD = 50;
const MAX_COST_MIN_INTERVAL_MS = 14 * DAY_MS;
// Age at which the interval reaches halfway between min and max.
// f(age) = MIN + (MAX - MIN) * age / (age + HALF_SATURATION)
// → f(365d) ≈ 30d, f(180d) ≈ 20d, f(30d) ≈ 5.5d, f(∞) → 60d
const HALF_SATURATION_MS = 365 * DAY_MS;

export interface SchedulingDecision {
  isDue: boolean;
  lastRunTime: number | null;
  openRouterFirstSeenAt: number | null;
  averageRunCostUsd: number | null;
  targetIntervalMs: number;
}

export interface SchedulingMetadata {
  decision: SchedulingDecision;
  modelExists: boolean;
}

export function computeTargetIntervalMs(
  openRouterFirstSeenAt: number | null,
  now = Date.now(),
  averageRunCostUsd: number | null = null,
): number {
  const ageInterval =
    openRouterFirstSeenAt === null
      ? MIN_INTERVAL_MS
      : MIN_INTERVAL_MS +
        (MAX_INTERVAL_MS - MIN_INTERVAL_MS) *
          Math.max(0, now - openRouterFirstSeenAt) /
          (Math.max(0, now - openRouterFirstSeenAt) + HALF_SATURATION_MS);
  return Math.max(ageInterval, computeCostMinimumIntervalMs(averageRunCostUsd));
}

export function computeCostMinimumIntervalMs(
  averageRunCostUsd: number | null,
): number {
  if (
    averageRunCostUsd === null ||
    !Number.isFinite(averageRunCostUsd) ||
    averageRunCostUsd <= COST_BIAS_START_USD
  ) {
    return MIN_INTERVAL_MS;
  }

  const costRange = COST_BIAS_FULL_USD - COST_BIAS_START_USD;
  const intervalRange = MAX_COST_MIN_INTERVAL_MS - MIN_INTERVAL_MS;
  const clampedCost = Math.min(averageRunCostUsd, COST_BIAS_FULL_USD);
  const costProgress = (clampedCost - COST_BIAS_START_USD) / costRange;
  return MIN_INTERVAL_MS + intervalRange * costProgress;
}

export function getSchedulingDecision(
  lastRunTime: number | null,
  openRouterFirstSeenAt: number | null,
  now = Date.now(),
  averageRunCostUsd: number | null = null,
): SchedulingDecision {
  const targetIntervalMs = computeTargetIntervalMs(
    openRouterFirstSeenAt,
    now,
    averageRunCostUsd,
  );
  return {
    isDue: lastRunTime === null || now - lastRunTime >= targetIntervalMs,
    lastRunTime,
    openRouterFirstSeenAt,
    averageRunCostUsd,
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
  const schedulingStats = await Promise.all(
    modelDocs.map((modelDoc) =>
      modelDoc === null
        ? Promise.resolve(null)
        : client.query(api.modelScores.getSchedulingStats, {
            modelId: modelDoc._id,
          }),
    ),
  );

  return new Map(
    uniqueSlugs.map((slug, index) => {
      const modelDoc = modelDocs[index];
      return [
        slug,
        {
          decision: getSchedulingDecision(
            schedulingStats[index]?.latestRunTime ?? null,
            modelDoc?.openRouterFirstSeenAt ?? null,
            now,
            schedulingStats[index]?.averageRunCostUsd ?? null,
          ),
          modelExists: modelDoc !== null,
        },
      ] as const;
    }),
  );
}
