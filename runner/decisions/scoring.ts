import type { ProviderAttempt, ProviderOutcome } from "./providers.js";
import type { DecisionQuestion, PresentedQuestion } from "./questions.js";

export interface PlannedQuestion {
  key: string;
  sourceEval: string;
  repetition: number;
  question: DecisionQuestion;
  presented: PresentedQuestion;
}
export interface QuestionResult {
  key: string;
  sourceEval: string;
  repetition: number;
  kind: ProviderOutcome["kind"];
  correct: boolean;
  selectedCanonicalId: string | null;
  expectedCanonicalId: string;
  outcome: ProviderOutcome;
}

export function gradeQuestion(
  planned: PlannedQuestion,
  outcome: ProviderOutcome,
): QuestionResult {
  const selected = outcome.answer
    ? (planned.presented.displayToCanonical[outcome.answer.choice] ?? null)
    : null;
  return {
    key: planned.key,
    sourceEval: planned.sourceEval,
    repetition: planned.repetition,
    kind: outcome.kind,
    correct:
      outcome.kind === "answered" &&
      selected === planned.question.correctOptionId,
    selectedCanonicalId: selected,
    expectedCanonicalId: planned.question.correctOptionId,
    outcome,
  };
}

function mean(values: number[]): number {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}
function quantile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
}

/** Planned IDs define the denominator. Missing or failed responses never improve
 * a score, and an interrupted run remains visibly incomplete. */
export function summarizeResults(
  planned: PlannedQuestion[],
  results: QuestionResult[],
  attempts: ProviderAttempt[] = results.flatMap(
    (result) => result.outcome.attempts,
  ),
) {
  const expected = new Set(planned.map((item) => item.key));
  if (expected.size !== planned.length)
    throw new Error("Duplicate planned question IDs");
  const byKey = new Map<string, QuestionResult>();
  for (const result of results) {
    if (!expected.has(result.key))
      throw new Error(`Unplanned result ${result.key}`);
    if (byKey.has(result.key))
      throw new Error(`Duplicate result ${result.key}`);
    const plan = planned.find((item) => item.key === result.key)!;
    if (
      result.sourceEval !== plan.sourceEval ||
      result.repetition !== plan.repetition
    )
      throw new Error(`Result identity mismatch ${result.key}`);
    byKey.set(result.key, result);
  }
  const evalValues = new Map<string, number[]>();
  for (const item of planned) {
    const list = evalValues.get(item.sourceEval) ?? [];
    list.push(byKey.get(item.key)?.correct ? 1 : 0);
    evalValues.set(item.sourceEval, list);
  }
  const evalScores = Object.fromEntries(
    [...evalValues].map(([id, values]) => [id, mean(values)]),
  );
  const categories = new Map<string, number[]>();
  for (const [id, score] of Object.entries(evalScores)) {
    const category = id.split("/")[0];
    categories.set(category, [...(categories.get(category) ?? []), score]);
  }
  const repetitions = new Map<number, Map<string, number[]>>();
  for (const item of planned) {
    const evals =
      repetitions.get(item.repetition) ?? new Map<string, number[]>();
    evals.set(item.sourceEval, [
      ...(evals.get(item.sourceEval) ?? []),
      byKey.get(item.key)?.correct ? 1 : 0,
    ]);
    repetitions.set(item.repetition, evals);
  }
  const allCostsKnown =
    attempts.length > 0 &&
    attempts.every((attempt) => {
      const response = attempt.response as {
        usage?: { cost?: unknown };
      } | null;
      return (
        typeof response?.usage?.cost === "number" &&
        Number.isFinite(response.usage.cost) &&
        response.usage.cost >= 0
      );
    });
  const knownCostUsd = attempts.reduce((sum, attempt) => {
    const cost = (attempt.response as { usage?: { cost?: unknown } } | null)
      ?.usage?.cost;
    return (
      sum +
      (typeof cost === "number" && Number.isFinite(cost) && cost >= 0
        ? cost
        : 0)
    );
  }, 0);
  return {
    complete: results.length === planned.length && planned.length > 0,
    plannedQuestions: planned.length,
    completedQuestions: results.length,
    missingQuestions: planned.length - results.length,
    sourceEvals: evalValues.size,
    correctQuestions: results.filter((result) => result.correct).length,
    questionAccuracy: planned.length
      ? results.filter((result) => result.correct).length / planned.length
      : 0,
    score: mean(Object.values(evalScores)),
    fullyCorrectEvals: Object.values(evalScores).filter((score) => score === 1)
      .length,
    categoryScores: Object.fromEntries(
      [...categories].map(([category, scores]) => [category, mean(scores)]),
    ),
    evalScores,
    repetitionScores: Object.fromEntries(
      [...repetitions].map(([repetition, evals]) => [
        repetition,
        mean([...evals.values()].map(mean)),
      ]),
    ),
    invalidResponses: results.filter(
      (result) => result.kind === "invalid_response",
    ).length,
    providerErrors: results.filter((result) => result.kind === "provider_error")
      .length,
    medianDurationMs: quantile(
      results.map((result) => result.outcome.durationMs),
      0.5,
    ),
    p95DurationMs: quantile(
      results.map((result) => result.outcome.durationMs),
      0.95,
    ),
    requestAttempts: attempts.length,
    costUsd: allCostsKnown ? knownCostUsd : null,
    knownCostUsd,
    costComplete: allCostsKnown,
  };
}
