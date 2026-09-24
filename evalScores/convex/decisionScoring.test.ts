import { describe, expect, it } from "vitest";
import type { Id } from "./_generated/dataModel.js";
import type { DecisionResult, DecisionRun } from "./documentKinds.js";
import {
  aggregateDecisionRuns,
  computeDecisionSummary,
  type DecisionSummary,
} from "./decisionScoring.js";

const run = {
  kind: "decision",
  _id: "run" as Id<"runs">,
  _creationTime: 1,
  benchmarkVersion: "benchmark" as Id<"benchmarkVersions">,
  runKey: "key",
  model: "test/model",
  condition: "no_guidelines",
  profile: {
    reasoningEffort: "low",
    maxOutputTokens: 10,
    timeoutMs: 1_000,
    maxRetries: 0,
    seed: "seed",
    repetitions: 1,
  },
  profileHash: "hash",
  plannedQuestions: ["cat/a/q1", "cat/a/q2", "cat/b/q1"],
  fullSuite: true,
  origin: { kind: "development", sourceCommit: null },
  status: "running",
} satisfies DecisionRun;

function result(
  questionKey: string,
  correct: boolean,
  costUsd: number | null,
): DecisionResult {
  return {
    kind: "decision",
    _id: `${questionKey}-result` as Id<"evals">,
    _creationTime: 1,
    runId: run._id,
    questionKey,
    repetition: 0,
    outcome: "answered",
    selectedCanonicalId: correct ? "correct" : "wrong",
    correct,
    returnedModel: "test/model",
    durationMs: 10,
    requestAttempts: 1,
    costUsd,
    knownCostUsd: costUsd ?? 0,
    evidence: {
      storageId: "storage" as Id<"_storage">,
      sha256: "a".repeat(64),
    },
  };
}

describe("decision scoring", () => {
  it("weights sources equally, counts missing slots as zero, and preserves unknown cost", () => {
    const summary = computeDecisionSummary(run, [
      result("cat/a/q1", true, 0),
      result("cat/a/q2", false, null),
      // cat/b/q1 is missing and therefore scores zero.
    ]);
    expect(summary.score).toBe(0.25); // mean([1/2, 0/1])
    expect(summary.categoryScores).toEqual({ cat: 0.25 });
    expect(summary.repetitionScores).toEqual([0.25]);
    expect(summary.completedQuestions).toBe(2);
    expect(summary.costUsd).toBeNull();
    expect(summary.knownCostUsd).toBe(0);
  });

  it("counts completed and unmatched orphan attempts once while exposing only known cost", () => {
    const summary = computeDecisionSummary(run, [result("cat/a/q1", true, 1)], {
      orphanAttempts: 2,
      orphanKnownCostUsd: 2,
      hasUnknownOrphanCost: true,
    });
    expect(summary.requestAttempts).toBe(3);
    expect(summary.knownCostUsd).toBe(3);
    expect(summary.costUsd).toBeNull();
  });
});

describe("decision estimated-cost aggregation", () => {
  const complete = (
    id: string,
    costs: Array<number | null>,
  ): {
    run: DecisionRun & { summary: DecisionSummary };
    results: DecisionResult[];
  } => {
    const results = run.plannedQuestions.map((key, index) => ({
      ...result(key, index === 0, costs[index]),
      outcome:
        costs[index] === null
          ? ("provider_error" as const)
          : ("answered" as const),
    }));
    return {
      run: {
        ...run,
        _id: id as Id<"runs">,
        status: "completed" as const,
        summary: computeDecisionSummary(run, results),
      },
      results,
    };
  };

  it("averages each run separately while keeping reported billing and scores intact", () => {
    const exact = complete("exact", [1, 1, 1]);
    const estimated = complete("estimated", [2, 2, null]);
    expect(estimated.run.summary.costUsd).toBeNull();
    expect(estimated.run.summary.knownCostUsd).toBe(4);
    expect(estimated.run.summary.estimatedCostUsd).toBe(6);
    const score = aggregateDecisionRuns([exact, estimated]);
    expect(score?.averageRunCostUsd).toBeNull();
    expect(score?.averageKnownRunCostUsd).toBe(3.5);
    expect(score?.estimatedAverageRunCostUsd).toBe(4.5);
    expect(score?.completeCostRunCount).toBe(1);
    expect(score?.score).toBe(0.25);
  });

  it("does not drop an unpriceable run, invent a sample, or mark exact totals estimated", () => {
    const exact = complete("exact", [1, 1, 1]);
    expect(
      aggregateDecisionRuns([exact])?.estimatedAverageRunCostUsd,
    ).toBeUndefined();
    const unknown = complete("unknown", [null, null, null]);
    expect(
      aggregateDecisionRuns([exact, unknown])?.estimatedAverageRunCostUsd,
    ).toBeUndefined();
    expect(
      aggregateDecisionRuns([exact, unknown])?.averageRunCostUsd,
    ).toBeNull();
  });

  it("does not estimate incomplete plans or orphan requests", () => {
    const row = complete("estimated", [1, 1, null]);
    expect(
      computeDecisionSummary(run, row.results.slice(0, 2)).estimatedCostUsd,
    ).toBeUndefined();
    expect(
      computeDecisionSummary(run, row.results, {
        orphanAttempts: 1,
        orphanKnownCostUsd: 0,
        hasUnknownOrphanCost: true,
      }).estimatedCostUsd,
    ).toBeUndefined();
  });
});
