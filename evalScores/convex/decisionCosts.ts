import type { DecisionResult } from "./documentKinds.js";

type CostResult = Pick<
  DecisionResult,
  "outcome" | "costUsd" | "knownCostUsd" | "requestAttempts"
>;

/** Estimate unpriced provider failures using reported costs from this run.
 * Keep this separate from the provider invoice and immutable answer evidence.
 * Incorrect and invalid answers still provide useful billing observations.
 */
export function estimateDecisionRunCost(
  results: CostResult[],
  plannedQuestions: number,
  orphanAttempts = 0,
): number | undefined {
  if (
    plannedQuestions === 0 ||
    results.length !== plannedQuestions ||
    orphanAttempts !== 0
  )
    return undefined;

  let knownCostUsd = 0;
  let sampleCostUsd = 0;
  let sampleAttempts = 0;
  let missingAttempts = 0;
  for (const result of results) {
    if (
      !Number.isInteger(result.requestAttempts) ||
      result.requestAttempts < 1 ||
      !Number.isFinite(result.knownCostUsd) ||
      result.knownCostUsd < 0
    )
      return undefined;
    knownCostUsd += result.knownCostUsd;
    if (result.costUsd === null) {
      // A received answer with missing usage is not evidence of an unanswered
      // request. Retries do not tell us how many attempts lack usage, even
      // when known cost is zero: [0, null] and [null, null] collapse to the
      // same totals. Leave these ambiguous cases unknown.
      if (
        result.outcome !== "provider_error" ||
        result.knownCostUsd !== 0 ||
        result.requestAttempts !== 1
      ) {
        return undefined;
      }
      missingAttempts += result.requestAttempts;
    } else {
      if (!Number.isFinite(result.costUsd) || result.costUsd < 0)
        return undefined;
      if (result.outcome !== "provider_error") {
        sampleCostUsd += result.costUsd;
        sampleAttempts += result.requestAttempts;
      }
    }
  }
  if (sampleAttempts === 0 || missingAttempts === 0) return undefined;
  const estimated =
    knownCostUsd + (sampleCostUsd / sampleAttempts) * missingAttempts;
  return Number.isFinite(estimated) ? estimated : undefined;
}
