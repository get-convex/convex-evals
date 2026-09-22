/**
 * Shared scoring helpers used by both runs.ts (leaderboardModelHistory)
 * and modelScores.ts (recomputeModelScores).
 */
import type { CodingEval, CodingRun } from "./documentKinds.js";

export const LEADERBOARD_HISTORY_SIZE = 10;

export function computeMeanAndStdDev(values: number[]): {
  mean: number;
  stdDev: number;
} {
  if (values.length === 0) return { mean: 0, stdDev: 0 };
  if (values.length === 1) return { mean: values[0], stdDev: 0 };
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance =
    values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  return { mean, stdDev: Math.sqrt(variance) };
}

export function isFullyCompletedRun(
  run: CodingRun,
  evals: CodingEval[],
): boolean {
  const planned = run.plannedEvals.length;
  if (planned === 0) return false;
  const finished = evals.filter(
    (e) => e.status.kind === "passed" || e.status.kind === "failed",
  ).length;
  return finished >= planned;
}

export function hasCompleteBenchmarkPlan(
  run: CodingRun,
  expectedEvalCount: number | undefined,
): boolean {
  return (
    expectedEvalCount !== undefined &&
    run.plannedEvals.length === expectedEvalCount
  );
}

export function getEvalCostUsd(evalDoc: CodingEval): number {
  const status = evalDoc.status;
  if (status.kind !== "passed" && status.kind !== "failed") return 0;
  const rawUsage = status.usage?.raw;
  if (!rawUsage || typeof rawUsage !== "object") return 0;
  if (!("cost" in rawUsage)) return 0;
  const cost = (rawUsage as { cost?: unknown }).cost;
  return typeof cost === "number" && Number.isFinite(cost) ? cost : 0;
}

export function hasIncompleteProviderUsage(evalDoc: CodingEval): boolean {
  const status = evalDoc.status;
  if (status.kind !== "passed" && status.kind !== "failed") return false;
  const raw: unknown = status.usage?.raw;
  if (raw === null || typeof raw !== "object") return false;
  if (
    "providerUsageExcludesFailedAttempts" in raw &&
    raw.providerUsageExcludesFailedAttempts === true
  ) {
    return true;
  }
  if (!("providerAttempts" in raw) || !Array.isArray(raw.providerAttempts)) {
    return false;
  }
  return raw.providerAttempts.some(
    (attempt: unknown) =>
      attempt !== null &&
      typeof attempt === "object" &&
      "outcome" in attempt &&
      attempt.outcome !== "success",
  );
}

export function computeRunCostUsd(evals: CodingEval[]): number | null {
  const answeredEvals = evals.filter(({ status }) => {
    if (status.kind !== "passed" && status.kind !== "failed") return false;
    const raw = status.usage?.raw;
    const attempts =
      raw && typeof raw === "object" ? raw.providerAttempts : null;
    // A failed eval with only failed provider attempts has no final answer to
    // price. It still counts as a failed eval in the score.
    const noAnswer =
      status.kind === "failed" &&
      Array.isArray(attempts) &&
      attempts.length > 0 &&
      attempts.every(
        (attempt) =>
          attempt !== null &&
          typeof attempt === "object" &&
          "outcome" in attempt &&
          typeof attempt.outcome === "string" &&
          ["empty_response", "rate_limit", "transient_error", "error"].includes(
            attempt.outcome,
          ),
      );
    return !noAnswer;
  });
  if (answeredEvals.length === 0) return null;
  // Cost follows the final generation used to score each eval. Discarded
  // provider attempts do not contribute, including when a retry succeeded.
  // Include generated answers that fail grading, but require a cost for every
  // received answer so missing generation usage cannot silently become zero.
  if (
    answeredEvals.some((evalDoc) => {
      const status = evalDoc.status;
      if (status.kind !== "passed" && status.kind !== "failed") return true;
      const raw = status.usage?.raw;
      if (raw === null || typeof raw !== "object" || !("cost" in raw)) {
        return true;
      }
      const cost = (raw as { cost?: unknown }).cost;
      return typeof cost !== "number" || !Number.isFinite(cost);
    })
  ) {
    return null;
  }
  return answeredEvals.reduce(
    (sum, evalDoc) => sum + getEvalCostUsd(evalDoc),
    0,
  );
}

export function computeRunDurationMs(evals: CodingEval[]): number | null {
  // Leaderboard speed compares mean model generation time per successful eval.
  // Failed provider requests count against score, but not model generation time.
  // Older evals fall back to scorer duration until the generation backfill runs.
  let total = 0;
  let completedCount = 0;
  for (const evalDoc of evals) {
    const status = evalDoc.status;
    if (status.kind !== "passed") continue;
    const durationMs = status.generationDurationMs ?? status.durationMs;
    if (!Number.isFinite(durationMs)) continue;
    total += durationMs;
    completedCount++;
  }
  return completedCount > 0 ? total / completedCount : null;
}

export function computeRunScores(evals: CodingEval[]): {
  totalScore: number;
  scores: Record<string, number>;
} {
  // Once retries are exhausted, every failed eval counts as a failure. Excluding
  // provider failures would let a model improve its score by skipping work.
  const completed = evals.filter(
    (e) => e.status.kind === "passed" || e.status.kind === "failed",
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
