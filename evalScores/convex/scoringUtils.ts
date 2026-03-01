/**
 * Shared scoring helpers used by both runs.ts (leaderboardModelHistory,
 * getSchedulingStats) and modelScores.ts (recomputeModelScores).
 */
import type { Doc } from "./_generated/dataModel";

export const LEADERBOARD_HISTORY_SIZE = 10;

export const LEADERBOARD_MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000;

export function computeMeanAndStdDev(values: number[]): { mean: number; stdDev: number } {
  if (values.length === 0) return { mean: 0, stdDev: 0 };
  if (values.length === 1) return { mean: values[0], stdDev: 0 };
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  return { mean, stdDev: Math.sqrt(variance) };
}

export function isFullyCompletedRun(run: Doc<"runs">, evals: Doc<"evals">[]): boolean {
  const planned = run.plannedEvals.length;
  if (planned === 0) return false;
  const finished = evals.filter(
    (e) => e.status.kind === "passed" || e.status.kind === "failed",
  ).length;
  return finished >= planned;
}

export function isRateLimitFailure(evalDoc: Doc<"evals">): boolean {
  if (evalDoc.status.kind !== "failed") return false;
  return evalDoc.status.failureReason.startsWith("[rate_limit]");
}

export function getEvalCostUsd(evalDoc: Doc<"evals">): number {
  const status = evalDoc.status;
  if (status.kind !== "passed" && status.kind !== "failed") return 0;
  const rawUsage = status.usage?.raw;
  if (!rawUsage || typeof rawUsage !== "object") return 0;
  if (!("cost" in rawUsage)) return 0;
  const cost = (rawUsage as { cost?: unknown }).cost;
  return typeof cost === "number" && Number.isFinite(cost) ? cost : 0;
}

export function computeRunCostUsd(evals: Doc<"evals">[]): number | null {
  const withCost = evals.filter((e) => {
    if (e.status.kind !== "passed" && e.status.kind !== "failed") return false;
    const raw = e.status.usage?.raw;
    return (
      raw !== undefined &&
      raw !== null &&
      typeof raw === "object" &&
      "cost" in raw &&
      typeof (raw as { cost?: unknown }).cost === "number"
    );
  });
  if (withCost.length === 0) return null;
  return withCost.reduce((sum, e) => sum + getEvalCostUsd(e), 0);
}

export function computeRunScores(
  evals: Doc<"evals">[],
): { totalScore: number; scores: Record<string, number> } {
  const completed = evals.filter(
    (e) =>
      (e.status.kind === "passed" || e.status.kind === "failed") &&
      !isRateLimitFailure(e),
  );
  if (completed.length === 0) return { totalScore: 0, scores: {} };

  const byCategory = new Map<string, { passed: number; total: number }>();
  let totalPassed = 0;
  for (const e of completed) {
    const cat = e.category;
    const existing = byCategory.get(cat) ?? { passed: 0, total: 0 };
    existing.total++;
    if (e.status.kind === "passed") {
      existing.passed++;
      totalPassed++;
    }
    byCategory.set(cat, existing);
  }

  const scores: Record<string, number> = {};
  for (const [cat, stats] of byCategory) {
    scores[cat] = stats.total > 0 ? stats.passed / stats.total : 0;
  }

  return {
    totalScore: completed.length > 0 ? totalPassed / completed.length : 0,
    scores,
  };
}
