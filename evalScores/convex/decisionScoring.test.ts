import { describe, expect, it } from "vitest";
import type { Id } from "./_generated/dataModel.js";
import type { DecisionResult, DecisionRun } from "./documentKinds.js";
import { computeDecisionSummary } from "./decisionScoring.js";

const run = {
  kind: "decision",
  _id: "run" as Id<"runs">,
  _creationTime: 1,
  benchmarkVersion: "benchmark" as Id<"benchmarkVersions">,
  runKey: "key",
  model: "test/model",
  condition: "no_guidelines",
  profile: { reasoningEffort: "low", maxOutputTokens: 10, timeoutMs: 1_000,
    maxRetries: 0, seed: "seed", repetitions: 1 },
  profileHash: "hash",
  plannedQuestions: ["cat/a/q1", "cat/a/q2", "cat/b/q1"],
  fullSuite: true,
  origin: { kind: "development", sourceCommit: null },
  status: "running",
} satisfies DecisionRun;

function result(questionKey: string, correct: boolean, costUsd: number | null): DecisionResult {
  return {
    kind: "decision", _id: `${questionKey}-result` as Id<"evals">, _creationTime: 1,
    runId: run._id, questionKey, repetition: 0, outcome: "answered",
    selectedCanonicalId: correct ? "correct" : "wrong", correct,
    returnedModel: "test/model", durationMs: 10, requestAttempts: 1,
    costUsd, knownCostUsd: costUsd ?? 0,
    evidence: { storageId: "storage" as Id<"_storage">, sha256: "a".repeat(64) },
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
    const summary = computeDecisionSummary(
      run,
      [result("cat/a/q1", true, 1)],
      { orphanAttempts: 2, orphanKnownCostUsd: 2, hasUnknownOrphanCost: true },
    );
    expect(summary.requestAttempts).toBe(3);
    expect(summary.knownCostUsd).toBe(3);
    expect(summary.costUsd).toBeNull();
  });
});
