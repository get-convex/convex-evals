import { describe, expect, it } from "vitest";
import { estimateDecisionRunCost } from "./decisionCosts.js";

type CostFixture = Parameters<typeof estimateDecisionRunCost>[0][number] & {
  correct: boolean;
};
const answered = (costUsd: number | null, correct = true): CostFixture => ({
  outcome: "answered" as const,
  correct,
  costUsd,
  knownCostUsd: costUsd ?? 0,
  requestAttempts: 1,
});
const failure = { ...answered(null), outcome: "provider_error" as const };

describe("decision cost estimates", () => {
  it("uses the run's mean billed cost and includes wrong and invalid answers", () => {
    const results = [
      answered(1),
      answered(2, false),
      { ...answered(3), outcome: "invalid_response" as const },
      failure,
    ];
    expect(estimateDecisionRunCost(results, 4)).toBe(8);
    expect(results[3].costUsd).toBeNull();
  });

  it("includes fully billed retries and retains billed provider failures", () => {
    const results = [
      { ...answered(2), requestAttempts: 2 },
      answered(2),
      { ...failure, costUsd: 0.5, knownCostUsd: 0.5 },
      failure,
    ];
    expect(estimateDecisionRunCost(results, 4)).toBeCloseTo(4.5 + 4 / 3);
  });

  it("keeps a genuine zero-cost sample distinct from missing billing", () => {
    expect(estimateDecisionRunCost([answered(0), failure], 2)).toBe(0);
    expect(estimateDecisionRunCost([failure, failure], 2)).toBeUndefined();
  });

  it("does not relabel complete billing as estimated", () => {
    expect(
      estimateDecisionRunCost([answered(1), answered(2)], 2),
    ).toBeUndefined();
  });

  it("does not guess missing usage on received answers or partly billed retries", () => {
    expect(
      estimateDecisionRunCost([answered(1), answered(null)], 2),
    ).toBeUndefined();
    expect(
      estimateDecisionRunCost(
        [answered(1), { ...failure, knownCostUsd: 0.2, requestAttempts: 2 }],
        2,
      ),
    ).toBeUndefined();
    // A reported zero plus a missing cost is indistinguishable from two
    // missing costs once attempts have been aggregated into one result.
    expect(
      estimateDecisionRunCost(
        [answered(1), { ...failure, knownCostUsd: 0, requestAttempts: 2 }],
        2,
      ),
    ).toBeUndefined();
  });

  it("does not extrapolate unfinished plans or unmatched requests", () => {
    expect(estimateDecisionRunCost([answered(1), failure], 3)).toBeUndefined();
    expect(
      estimateDecisionRunCost([answered(1), failure], 2, 1),
    ).toBeUndefined();
    expect(estimateDecisionRunCost([], 0)).toBeUndefined();
    expect(
      estimateDecisionRunCost(
        [answered(1), { ...failure, requestAttempts: 0 }],
        2,
      ),
    ).toBeUndefined();
  });
});
