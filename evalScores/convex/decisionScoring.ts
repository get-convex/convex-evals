import { estimateDecisionRunCost } from "./decisionCosts.js";
import type { DecisionResult, DecisionRun } from "./documentKinds.js";

export const DECISION_SCORE_RUN_LIMIT = 10;

function mean(values: number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((total, value) => total + value, 0) / values.length;
}

function percentile(values: number[], quantile: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(quantile * sorted.length) - 1;
  return sorted[Math.max(0, rank)];
}

function sourceOf(questionKey: string): string {
  const slash = questionKey.lastIndexOf("/");
  if (slash <= 0) throw new Error(`Invalid decision question key: ${questionKey}`);
  return questionKey.slice(0, slash);
}

function categoryOf(sourceEval: string): string {
  return sourceEval.split("/", 1)[0];
}

export interface DecisionSummary {
  score: number;
  categoryScores: Record<string, number>;
  repetitionScores: number[];
  completedQuestions: number;
  correctQuestions: number;
  invalidResponses: number;
  providerErrors: number;
  requestAttempts: number;
  costUsd: number | null;
  knownCostUsd: number;
  estimatedCostUsd?: number;
  medianDurationMs: number | null;
  p95DurationMs: number | null;
}

/**
 * Score every planned slot. Missing slots are zero and sources have equal
 * weight, so a source with more authored questions cannot dominate the score.
 */
export function computeDecisionSummary(
  run: DecisionRun,
  results: DecisionResult[],
  journal: {
    orphanAttempts: number;
    orphanKnownCostUsd: number;
    hasUnknownOrphanCost: boolean;
  } = {
    orphanAttempts: 0,
    orphanKnownCostUsd: 0,
    hasUnknownOrphanCost: false,
  },
): DecisionSummary {
  const bySlot = new Map(
    results.map((result) => [
      `${result.questionKey}/${result.repetition}`,
      result,
    ]),
  );
  if (bySlot.size !== results.length) {
    throw new Error("Decision results contain duplicate slots");
  }

  const sourceScores = new Map<string, number[]>();
  const repetitionSourceScores = Array.from(
    { length: run.profile.repetitions },
    () => new Map<string, number[]>(),
  );
  for (const questionKey of run.plannedQuestions) {
    const source = sourceOf(questionKey);
    for (let repetition = 0; repetition < run.profile.repetitions; repetition++) {
      const correct = bySlot.get(`${questionKey}/${repetition}`)?.correct ? 1 : 0;
      const scores = sourceScores.get(source) ?? [];
      scores.push(correct);
      sourceScores.set(source, scores);
      const repetitionScores = repetitionSourceScores[repetition];
      const perSource = repetitionScores.get(source) ?? [];
      perSource.push(correct);
      repetitionScores.set(source, perSource);
    }
  }

  const sourceMeans = [...sourceScores.entries()].map(([source, scores]) => ({
    source,
    score: mean(scores),
  }));
  const categories = new Map<string, number[]>();
  for (const item of sourceMeans) {
    const category = categoryOf(item.source);
    const scores = categories.get(category) ?? [];
    scores.push(item.score);
    categories.set(category, scores);
  }

  const knownCostUsd =
    results.reduce((total, result) => total + result.knownCostUsd, 0) +
    journal.orphanKnownCostUsd;
  const completeCost =
    !journal.hasUnknownOrphanCost && results.every((result) => result.costUsd !== null);
  const estimatedCostUsd = completeCost || journal.hasUnknownOrphanCost
    ? undefined
    : estimateDecisionRunCost(
        results,
        run.plannedQuestions.length * run.profile.repetitions,
        journal.orphanAttempts,
      );
  const durations = results.map((result) => result.durationMs);

  return {
    score: mean(sourceMeans.map(({ score }) => score)),
    categoryScores: Object.fromEntries(
      [...categories.entries()].map(([category, scores]) => [category, mean(scores)]),
    ),
    repetitionScores: repetitionSourceScores.map((sources) =>
      mean([...sources.values()].map((scores) => mean(scores))),
    ),
    completedQuestions: results.length,
    correctQuestions: results.filter((result) => result.correct).length,
    invalidResponses: results.filter(
      (result) => result.outcome === "invalid_response",
    ).length,
    providerErrors: results.filter((result) => result.outcome === "provider_error").length,
    requestAttempts:
      results.reduce((total, result) => total + result.requestAttempts, 0) +
      journal.orphanAttempts,
    costUsd: completeCost
      ? results.reduce((total, result) => total + (result.costUsd ?? 0), 0) +
        journal.orphanKnownCostUsd
      : null,
    knownCostUsd,
    ...(estimatedCostUsd !== undefined ? { estimatedCostUsd } : {}),
    medianDurationMs: percentile(durations, 0.5),
    p95DurationMs: percentile(durations, 0.95),
  };
}

export function computeMeanAndPopulationStdDev(values: number[]): {
  mean: number;
  stdDev: number;
} {
  const average = mean(values);
  return {
    mean: average,
    stdDev:
      values.length === 0
        ? 0
        : Math.sqrt(
            mean(values.map((value) => (value - average) ** 2)),
          ),
  };
}

export function aggregateDecisionRuns(
  rows: Array<{ run: DecisionRun; results: DecisionResult[] }>,
) {
  const selected = [...rows]
    .filter(({ run }) => run.status === "completed" && run.fullSuite && run.summary)
    .sort((a, b) => b.run._creationTime - a.run._creationTime)
    .slice(0, DECISION_SCORE_RUN_LIMIT);
  if (selected.length === 0) return null;

  const latest = selected[0].run;
  const summaries = selected.map(({ run }) => run.summary!);
  const scores = computeMeanAndPopulationStdDev(summaries.map((summary) => summary.score));
  const categoryNames = new Set(
    summaries.flatMap((summary) => Object.keys(summary.categoryScores)),
  );
  const durations = selected.flatMap(({ results }) =>
    results.map((result) => result.durationMs),
  );
  const completeCostRunCount = summaries.filter(
    (summary) => summary.costUsd !== null,
  ).length;
  const allCostsComplete = completeCostRunCount === summaries.length;
  const comparableCosts = summaries.map(
    (summary) => summary.costUsd ?? summary.estimatedCostUsd ?? null,
  );
  // Every contributing run needs a price. Never improve the cost comparison by
  // silently dropping the runs whose billing is still unknown.
  const estimatedAverageRunCostUsd = !allCostsComplete &&
    comparableCosts.every((cost): cost is number => cost !== null)
    ? mean(comparableCosts)
    : undefined;

  return {
    kind: "decision" as const,
    benchmarkVersion: latest.benchmarkVersion,
    model: latest.model,
    condition: latest.condition,
    profileHash: latest.profileHash,
    score: scores.mean,
    scoreStdDev: scores.stdDev,
    categoryScores: Object.fromEntries(
      [...categoryNames].map((category) => [
        category,
        mean(summaries.map((summary) => summary.categoryScores[category] ?? 0)),
      ]),
    ),
    runCount: selected.length,
    plannedQuestions: selected.reduce(
      (total, { run }) => total + run.plannedQuestions.length * run.profile.repetitions,
      0,
    ),
    invalidResponses: summaries.reduce(
      (total, summary) => total + summary.invalidResponses,
      0,
    ),
    providerErrors: summaries.reduce(
      (total, summary) => total + summary.providerErrors,
      0,
    ),
    averageRunDurationMs: mean(selected.map(({ run }) => run.durationMs ?? 0)),
    medianQuestionDurationMs: percentile(durations, 0.5),
    p95QuestionDurationMs: percentile(durations, 0.95),
    averageKnownRunCostUsd: mean(
      summaries.map((summary) => summary.knownCostUsd),
    ),
    completeCostRunCount,
    averageRunCostUsd: allCostsComplete
      ? mean(summaries.map((summary) => summary.costUsd!))
      : null,
    ...(estimatedAverageRunCostUsd !== undefined
      ? { estimatedAverageRunCostUsd }
      : {}),
    latestRunId: latest._id,
    latestRunTime: latest._creationTime,
  };
}
