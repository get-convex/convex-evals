import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { modules } from "./test.setup";

// Prevent scheduled functions (from completeRun/deleteRun) from firing
// asynchronously during tests and causing "write outside of transaction" errors.
// Each test drains its own scheduled functions explicitly via the helper.
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

/**
 * Helper: Create a completed run with the given evals.
 * Each eval is specified as { category, name, passed }.
 */
async function createCompletedRunWithEvals(
  t: ReturnType<typeof convexTest>,
  opts: {
    model: string;
    formattedName?: string;
    provider?: string;
    experiment?: "no_guidelines";
    evals: Array<{
      category: string;
      name: string;
      passed: boolean;
      costUsd?: number;
    }>;
  },
): Promise<Id<"runs">> {
  const runId = await t.mutation(internal.runs.createRun, {
    model: opts.model,
    formattedName: opts.formattedName ?? opts.model,
    provider: opts.provider ?? "test",
    plannedEvals: opts.evals.map((e) => `${e.category}/${e.name}`),
    experiment: opts.experiment,
  });

  // Create and complete each eval
  for (const evalDef of opts.evals) {
    const evalId = await t.mutation(internal.evals.createEval, {
      runId,
      evalPath: `${evalDef.category}/${evalDef.name}`,
      category: evalDef.category,
      name: evalDef.name,
    });

    await t.mutation(internal.evals.completeEval, {
      evalId,
      status: evalDef.passed
        ? {
            kind: "passed" as const,
            durationMs: 1000,
            usage:
              evalDef.costUsd !== undefined
                ? { raw: { cost: evalDef.costUsd } }
                : undefined,
          }
        : {
            kind: "failed" as const,
            failureReason: "test failure",
            durationMs: 1000,
            usage:
              evalDef.costUsd !== undefined
                ? { raw: { cost: evalDef.costUsd } }
                : undefined,
          },
    });
  }

  await t.mutation(internal.runs.completeRun, {
    runId,
    status: { kind: "completed", durationMs: 5000 },
  });

  // Advance fake time past the 0ms mark so the scheduled recomputeModelScores
  // moves from "pending" to "in-progress", then wait for it to complete.
  vi.runAllTimers();
  await t.finishInProgressScheduledFunctions();

  return runId;
}

describe("leaderboardScores", () => {
  it("returns empty array when no completed runs exist", async () => {
    const t = convexTest(schema, modules);

    const results = await t.query(api.runs.leaderboardScores, {});
    expect(results).toEqual([]);
  });

  it("returns empty array when only pending runs exist", async () => {
    const t = convexTest(schema, modules);

    // Create a run but don't complete it
    await t.mutation(internal.runs.createRun, {
      model: "test-model",
      formattedName: "test-model",
      provider: "test",
      plannedEvals: ["cat1/eval1"],
    });

    const results = await t.query(api.runs.leaderboardScores, {});
    expect(results).toEqual([]);
  });

  it("computes correct pass rate per category from evals", async () => {
    const t = convexTest(schema, modules);

    await createCompletedRunWithEvals(t, {
      model: "test-model",
      formattedName: "Test Model",
      evals: [
        { category: "cat1", name: "eval1", passed: true },
        { category: "cat1", name: "eval2", passed: false },
        { category: "cat2", name: "eval3", passed: true },
        { category: "cat2", name: "eval4", passed: true },
      ],
    });

    const results = await t.query(api.runs.leaderboardScores, {});

    expect(results).toHaveLength(1);
    const entry = results[0];
    expect(entry.model).toBe("test-model");
    expect(entry.formattedName).toBe("Test Model");

    // cat1: 1/2 = 0.5, cat2: 2/2 = 1.0
    expect(entry.scores.cat1).toBe(0.5);
    expect(entry.scores.cat2).toBe(1.0);

    // totalScore: 3/4 = 0.75
    expect(entry.totalScore).toBe(0.75);

    // Only one run, so error bars should be 0
    expect(entry.totalScoreErrorBar).toBe(0);
    expect(entry.scoreErrorBars.cat1).toBe(0);
    expect(entry.scoreErrorBars.cat2).toBe(0);
  });

  it("computes mean and standard deviation across multiple runs", async () => {
    const t = convexTest(schema, modules);

    // Run 1: all pass -> totalScore = 1.0
    await createCompletedRunWithEvals(t, {
      model: "test-model",
      formattedName: "Test Model",
      evals: [
        { category: "cat1", name: "eval1", passed: true },
        { category: "cat1", name: "eval2", passed: true },
      ],
    });

    // Run 2: none pass -> totalScore = 0.0
    await createCompletedRunWithEvals(t, {
      model: "test-model",
      formattedName: "Test Model",
      evals: [
        { category: "cat1", name: "eval1", passed: false },
        { category: "cat1", name: "eval2", passed: false },
      ],
    });

    const results = await t.query(api.runs.leaderboardScores, {});

    expect(results).toHaveLength(1);
    const entry = results[0];

    // Mean of 1.0 and 0.0 = 0.5
    expect(entry.totalScore).toBe(0.5);
    // SD: sqrt(((1.0-0.5)^2 + (0.0-0.5)^2) / 2) = sqrt((0.25 + 0.25) / 2) = sqrt(0.25) = 0.5
    expect(entry.totalScoreErrorBar).toBe(0.5);

    // cat1: mean of 1.0 and 0.0 = 0.5
    expect(entry.scores.cat1).toBe(0.5);
    expect(entry.scoreErrorBars.cat1).toBe(0.5);

    expect(entry.runCount).toBe(2);
  });

  it("computes average run cost and error bar from eval usage", async () => {
    const t = convexTest(schema, modules);

    // Run 1 total cost: $1.00
    await createCompletedRunWithEvals(t, {
      model: "cost-model",
      formattedName: "Cost Model",
      evals: [
        { category: "cat1", name: "eval1", passed: true, costUsd: 0.3 },
        { category: "cat1", name: "eval2", passed: true, costUsd: 0.7 },
      ],
    });

    // Run 2 total cost: $3.00
    await createCompletedRunWithEvals(t, {
      model: "cost-model",
      formattedName: "Cost Model",
      evals: [
        { category: "cat1", name: "eval1", passed: true, costUsd: 1.0 },
        { category: "cat1", name: "eval2", passed: true, costUsd: 2.0 },
      ],
    });

    const results = await t.query(api.runs.leaderboardScores, {});
    const entry = results.find((r) => r.model === "cost-model");
    expect(entry).toBeDefined();

    // Mean of [1.0, 3.0] = 2.0
    expect(entry!.averageRunCostUsd).toBeCloseTo(2.0);
    // Population stddev of [1.0, 3.0] = 1.0
    expect(entry!.averageRunCostUsdErrorBar).toBeCloseTo(1.0);
  });

  it("returns null run cost fields when cost data is unavailable", async () => {
    const t = convexTest(schema, modules);

    await createCompletedRunWithEvals(t, {
      model: "no-cost-model",
      formattedName: "No Cost Model",
      evals: [
        { category: "cat1", name: "eval1", passed: true },
        { category: "cat1", name: "eval2", passed: false },
      ],
    });

    const results = await t.query(api.runs.leaderboardScores, {});
    const entry = results.find((r) => r.model === "no-cost-model");
    expect(entry).toBeDefined();
    expect(entry!.averageRunCostUsd).toBeNull();
    expect(entry!.averageRunCostUsdErrorBar).toBeNull();
  });

  it("only uses last 10 runs for statistics", async () => {
    const t = convexTest(schema, modules);

    // Create 12 runs. First 2 score 0.0, rest score 1.0.
    // Only the last 10 should be used (most recent 10).
    // The 2 zero-score runs are the oldest and should be excluded.

    // Runs 1-2: score 0 (should be excluded as oldest)
    for (let i = 0; i < 2; i++) {
      await createCompletedRunWithEvals(t, {
        model: "test-model",
        evals: [
          { category: "cat1", name: "eval1", passed: false },
          { category: "cat1", name: "eval2", passed: false },
        ],
      });
    }

    // Runs 3-12: score 1.0 (these are the 10 most recent)
    for (let i = 0; i < 10; i++) {
      await createCompletedRunWithEvals(t, {
        model: "test-model",
        evals: [
          { category: "cat1", name: "eval1", passed: true },
          { category: "cat1", name: "eval2", passed: true },
        ],
      });
    }

    const results = await t.query(api.runs.leaderboardScores, {});

    expect(results).toHaveLength(1);
    const entry = results[0];

    // Only the 10 most recent runs used, all score 1.0
    expect(entry.totalScore).toBeCloseTo(1.0);
    expect(entry.runCount).toBe(10);
  });

  it("filters by experiment correctly", async () => {
    const t = convexTest(schema, modules);

    // Default run
    await createCompletedRunWithEvals(t, {
      model: "test-model",
      formattedName: "Test Model",
      evals: [
        { category: "cat1", name: "eval1", passed: true },
        { category: "cat1", name: "eval2", passed: true },
      ],
    });

    // no_guidelines run
    await createCompletedRunWithEvals(t, {
      model: "test-model",
      formattedName: "Test Model",
      experiment: "no_guidelines",
      evals: [
        { category: "cat1", name: "eval1", passed: false },
        { category: "cat1", name: "eval2", passed: false },
      ],
    });

    // Default query should only include the default run
    const defaultResults = await t.query(api.runs.leaderboardScores, {});
    expect(defaultResults).toHaveLength(1);
    expect(defaultResults[0].totalScore).toBe(1.0);

    // Experiment query
    const expResults = await t.query(api.runs.leaderboardScores, {
      experiment: "no_guidelines",
    });
    expect(expResults).toHaveLength(1);
    expect(expResults[0].totalScore).toBe(0.0);
  });

  it("excludes completed runs with incomplete evals", async () => {
    const t = convexTest(schema, modules);

    // Create a fully-completed run with a good score
    await createCompletedRunWithEvals(t, {
      model: "test-model",
      formattedName: "Test Model",
      evals: [
        { category: "cat1", name: "eval1", passed: true },
        { category: "cat1", name: "eval2", passed: true },
      ],
    });

    // Create a "completed" run where no evals finished (ghost run)
    const ghostRunId = await t.mutation(internal.runs.createRun, {
      model: "test-model",
      formattedName: "Test Model",
      provider: "test",
      plannedEvals: ["cat1/eval1", "cat1/eval2"],
    });
    await t.mutation(internal.runs.completeRun, {
      runId: ghostRunId,
      status: { kind: "completed", durationMs: 500 },
    });

    const results = await t.query(api.runs.leaderboardScores, {});

    // Ghost run should be excluded — only the real run counts
    expect(results).toHaveLength(1);
    expect(results[0].totalScore).toBe(1.0);
    expect(results[0].runCount).toBe(1);
  });

  it("returns formattedName alongside model name", async () => {
    const t = convexTest(schema, modules);

    await createCompletedRunWithEvals(t, {
      model: "claude-opus-4-5",
      formattedName: "Claude 4.5 Opus",
      evals: [{ category: "cat1", name: "eval1", passed: true }],
    });

    const results = await t.query(api.runs.leaderboardScores, {});

    expect(results).toHaveLength(1);
    expect(results[0].model).toBe("claude-opus-4-5");
    expect(results[0].formattedName).toBe("Claude 4.5 Opus");
  });

  it("returns latestRunId for deep linking", async () => {
    const t = convexTest(schema, modules);

    const runId1 = await createCompletedRunWithEvals(t, {
      model: "test-model",
      evals: [{ category: "cat1", name: "eval1", passed: true }],
    });

    const runId2 = await createCompletedRunWithEvals(t, {
      model: "test-model",
      evals: [{ category: "cat1", name: "eval1", passed: true }],
    });

    const results = await t.query(api.runs.leaderboardScores, {});

    expect(results).toHaveLength(1);
    // Latest run should be runId2 (created second)
    expect(results[0].latestRunId).toBe(runId2);
  });

  it("handles multiple models separately", async () => {
    const t = convexTest(schema, modules);

    await createCompletedRunWithEvals(t, {
      model: "model-a",
      formattedName: "Model A",
      evals: [
        { category: "cat1", name: "eval1", passed: true },
        { category: "cat1", name: "eval2", passed: true },
      ],
    });

    await createCompletedRunWithEvals(t, {
      model: "model-b",
      formattedName: "Model B",
      evals: [
        { category: "cat1", name: "eval1", passed: false },
        { category: "cat1", name: "eval2", passed: false },
      ],
    });

    const results = await t.query(api.runs.leaderboardScores, {});

    expect(results).toHaveLength(2);
    // Sorted by model name
    const modelA = results.find((r) => r.model === "model-a");
    const modelB = results.find((r) => r.model === "model-b");
    expect(modelA).toBeDefined();
    expect(modelB).toBeDefined();
    expect(modelA!.totalScore).toBe(1.0);
    expect(modelB!.totalScore).toBe(0.0);
  });
});

describe("leaderboardModelHistory", () => {
  it("returns empty array when no runs exist for model", async () => {
    const t = convexTest(schema, modules);

    const result = await t.query(api.runs.leaderboardModelHistory, {
      model: "nonexistent",
    });

    expect(result).toEqual([]);
  });

  it("returns runs in chronological order (oldest first)", async () => {
    const t = convexTest(schema, modules);

    const runId1 = await createCompletedRunWithEvals(t, {
      model: "test-model",
      evals: [
        { category: "cat1", name: "eval1", passed: false },
        { category: "cat1", name: "eval2", passed: false },
      ],
    });

    const runId2 = await createCompletedRunWithEvals(t, {
      model: "test-model",
      evals: [
        { category: "cat1", name: "eval1", passed: true },
        { category: "cat1", name: "eval2", passed: false },
      ],
    });

    const runId3 = await createCompletedRunWithEvals(t, {
      model: "test-model",
      evals: [
        { category: "cat1", name: "eval1", passed: true },
        { category: "cat1", name: "eval2", passed: true },
      ],
    });

    const result = await t.query(api.runs.leaderboardModelHistory, {
      model: "test-model",
    });

    expect(result).toHaveLength(3);
    // Oldest first
    expect(result[0].runId).toBe(runId1);
    expect(result[0].totalScore).toBe(0.0);
    expect(result[1].runId).toBe(runId2);
    expect(result[1].totalScore).toBe(0.5);
    expect(result[2].runId).toBe(runId3);
    expect(result[2].totalScore).toBe(1.0);
  });

  it("filters by experiment when provided", async () => {
    const t = convexTest(schema, modules);

    await createCompletedRunWithEvals(t, {
      model: "test-model",
      evals: [{ category: "cat1", name: "eval1", passed: true }],
    });

    await createCompletedRunWithEvals(t, {
      model: "test-model",
      experiment: "no_guidelines",
      evals: [{ category: "cat1", name: "eval1", passed: false }],
    });

    // Default query should only return default runs
    const defaultHistory = await t.query(api.runs.leaderboardModelHistory, {
      model: "test-model",
    });
    expect(defaultHistory).toHaveLength(1);
    expect(defaultHistory[0].totalScore).toBe(1.0);

    // Experiment query
    const expHistory = await t.query(api.runs.leaderboardModelHistory, {
      model: "test-model",
      experiment: "no_guidelines",
    });
    expect(expHistory).toHaveLength(1);
    expect(expHistory[0].totalScore).toBe(0.0);
  });

  it("includes runId (the runs._id) for deep linking", async () => {
    const t = convexTest(schema, modules);

    const runId = await createCompletedRunWithEvals(t, {
      model: "test-model",
      evals: [{ category: "cat1", name: "eval1", passed: true }],
    });

    const result = await t.query(api.runs.leaderboardModelHistory, {
      model: "test-model",
    });

    expect(result).toHaveLength(1);
    expect(result[0].runId).toBe(runId);
  });

  it("computes per-run scores correctly with multiple categories", async () => {
    const t = convexTest(schema, modules);

    await createCompletedRunWithEvals(t, {
      model: "test-model",
      evals: [
        { category: "cat1", name: "eval1", passed: true },
        { category: "cat1", name: "eval2", passed: false },
        { category: "cat2", name: "eval3", passed: true },
        { category: "cat2", name: "eval4", passed: true },
        { category: "cat2", name: "eval5", passed: true },
      ],
    });

    const result = await t.query(api.runs.leaderboardModelHistory, {
      model: "test-model",
    });

    expect(result).toHaveLength(1);
    // cat1: 1/2 = 0.5, cat2: 3/3 = 1.0
    expect(result[0].scores.cat1).toBe(0.5);
    expect(result[0].scores.cat2).toBe(1.0);
    // total: 4/5 = 0.8
    expect(result[0].totalScore).toBe(0.8);
  });

  it("only returns data for the specified model", async () => {
    const t = convexTest(schema, modules);

    await createCompletedRunWithEvals(t, {
      model: "model-a",
      evals: [{ category: "cat1", name: "eval1", passed: true }],
    });

    await createCompletedRunWithEvals(t, {
      model: "model-b",
      evals: [{ category: "cat1", name: "eval1", passed: false }],
    });

    const result = await t.query(api.runs.leaderboardModelHistory, {
      model: "model-a",
    });

    expect(result).toHaveLength(1);
    expect(result[0].totalScore).toBe(1.0);
  });

  it("respects limit parameter (returns most recent runs)", async () => {
    const t = convexTest(schema, modules);

    // Create 5 runs
    for (let i = 0; i < 5; i++) {
      await createCompletedRunWithEvals(t, {
        model: "test-model",
        evals: [{ category: "cat1", name: "eval1", passed: i >= 3 }],
      });
    }

    // Limit to 2 should return the last 2 runs
    const result = await t.query(api.runs.leaderboardModelHistory, {
      model: "test-model",
      limit: 2,
    });

    expect(result).toHaveLength(2);
    // Last 2 runs had i=3 (passed) and i=4 (passed)
    expect(result[0].totalScore).toBe(1.0);
    expect(result[1].totalScore).toBe(1.0);
  });

  it("excludes non-completed runs", async () => {
    const t = convexTest(schema, modules);

    // Create a completed run
    await createCompletedRunWithEvals(t, {
      model: "test-model",
      evals: [{ category: "cat1", name: "eval1", passed: true }],
    });

    // Create a pending run (not completed)
    await t.mutation(internal.runs.createRun, {
      model: "test-model",
      formattedName: "test-model",
      provider: "test",
      plannedEvals: ["cat1/eval1"],
    });

    const result = await t.query(api.runs.leaderboardModelHistory, {
      model: "test-model",
    });

    // Should only include the completed run
    expect(result).toHaveLength(1);
    expect(result[0].totalScore).toBe(1.0);
  });

  it("excludes completed runs with incomplete evals", async () => {
    const t = convexTest(schema, modules);

    // Create a fully-completed run
    await createCompletedRunWithEvals(t, {
      model: "test-model",
      evals: [{ category: "cat1", name: "eval1", passed: true }],
    });

    // Create a run marked as "completed" but with no evals actually finished
    // (simulates a run that errored out early)
    const incompleteRunId = await t.mutation(internal.runs.createRun, {
      model: "test-model",
      formattedName: "test-model",
      provider: "test",
      plannedEvals: ["cat1/eval1", "cat1/eval2"],
    });
    await t.mutation(internal.runs.completeRun, {
      runId: incompleteRunId,
      status: { kind: "completed", durationMs: 1000 },
    });

    const result = await t.query(api.runs.leaderboardModelHistory, {
      model: "test-model",
    });

    // Should only include the fully-completed run, not the incomplete one
    expect(result).toHaveLength(1);
    expect(result[0].totalScore).toBe(1.0);
  });

  it("includes _creationTime for chart display", async () => {
    const t = convexTest(schema, modules);

    await createCompletedRunWithEvals(t, {
      model: "test-model",
      evals: [{ category: "cat1", name: "eval1", passed: true }],
    });

    const result = await t.query(api.runs.leaderboardModelHistory, {
      model: "test-model",
    });

    expect(result).toHaveLength(1);
    expect(result[0]._creationTime).toBeDefined();
    expect(typeof result[0]._creationTime).toBe("number");
  });
});
