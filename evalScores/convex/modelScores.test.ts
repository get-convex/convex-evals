/**
 * Tests for the materialised modelScores table and recomputeModelScores mutation.
 *
 * Covers:
 * - recomputeModelScores correctly computes and upserts the row
 * - Row is deleted when all runs for a model are gone
 * - completeRun schedules a recompute (scheduler integration)
 * - deleteRun schedules a recompute
 * - Correct handling of multiple experiments
 * - Null cost when no cost data is present
 * - "Last 5 runs" cap is respected
 * - Rate-limit failures are excluded from scoring
 */
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { modules } from "./test.setup";

// Prevent scheduled functions from firing asynchronously and causing
// "write outside of transaction" errors.
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });
import type { Id } from "./_generated/dataModel";

// ── Test helper ───────────────────────────────────────────────────────

async function createCompletedRun(
  t: ReturnType<typeof convexTest>,
  opts: {
    model: string;
    formattedName?: string;
    experiment?: "no_guidelines";
    evals: Array<{
      category: string;
      name: string;
      passed: boolean;
      rateLimited?: boolean;
      costUsd?: number;
    }>;
  },
): Promise<Id<"runs">> {
  const runId = await t.mutation(internal.runs.createRun, {
    model: opts.model,
    formattedName: opts.formattedName ?? opts.model,
    provider: "test",
    plannedEvals: opts.evals.map((e) => `${e.category}/${e.name}`),
    experiment: opts.experiment,
  });

  for (const evalDef of opts.evals) {
    const evalId = await t.mutation(internal.evals.createEval, {
      runId,
      evalPath: `${evalDef.category}/${evalDef.name}`,
      category: evalDef.category,
      name: evalDef.name,
    });

    const usage =
      evalDef.costUsd !== undefined ? { raw: { cost: evalDef.costUsd } } : undefined;

    if (evalDef.rateLimited) {
      await t.mutation(internal.evals.completeEval, {
        evalId,
        status: {
          kind: "failed" as const,
          failureReason: "[rate_limit] 429 too many requests",
          durationMs: 100,
          usage,
        },
      });
    } else if (evalDef.passed) {
      await t.mutation(internal.evals.completeEval, {
        evalId,
        status: { kind: "passed" as const, durationMs: 1000, usage },
      });
    } else {
      await t.mutation(internal.evals.completeEval, {
        evalId,
        status: {
          kind: "failed" as const,
          failureReason: "test failure",
          durationMs: 1000,
          usage,
        },
      });
    }
  }

  await t.mutation(internal.runs.completeRun, {
    runId,
    status: { kind: "completed", durationMs: 5000 },
  });

  // Advance fake time past the 0ms mark so recomputeModelScores fires
  vi.runAllTimers();
  await t.finishInProgressScheduledFunctions();

  return runId;
}

// ── recomputeModelScores ──────────────────────────────────────────────

describe("recomputeModelScores", () => {
  it("inserts a row on first run completion", async () => {
    const t = convexTest(schema, modules);

    await createCompletedRun(t, {
      model: "model-a",
      formattedName: "Model A",
      evals: [
        { category: "cat1", name: "eval1", passed: true },
        { category: "cat1", name: "eval2", passed: false },
      ],
    });

    const results = await t.query(api.runs.leaderboardScores, {});
    expect(results).toHaveLength(1);
    expect(results[0].model).toBe("model-a");
    expect(results[0].formattedName).toBe("Model A");
    expect(results[0].totalScore).toBe(0.5);
    expect(results[0].runCount).toBe(1);
  });

  it("upserts the row on subsequent runs", async () => {
    const t = convexTest(schema, modules);

    await createCompletedRun(t, {
      model: "model-a",
      evals: [{ category: "cat1", name: "eval1", passed: true }],
    });
    await createCompletedRun(t, {
      model: "model-a",
      evals: [{ category: "cat1", name: "eval1", passed: false }],
    });

    const results = await t.query(api.runs.leaderboardScores, {});
    expect(results).toHaveLength(1);
    // Mean of 1.0 and 0.0
    expect(results[0].totalScore).toBe(0.5);
    expect(results[0].runCount).toBe(2);
  });

  it("deletes the row when all runs for a model are gone", async () => {
    const t = convexTest(schema, modules);

    const runId =     await createCompletedRun(t, {
      model: "model-a",
      evals: [{ category: "cat1", name: "eval1", passed: true }],
    });

    // Confirm row exists
    let results = await t.query(api.runs.leaderboardScores, {});
    expect(results).toHaveLength(1);

    // Delete the run - schedules a recompute
    await t.mutation(internal.runs.deleteRun, { runId });
    vi.runAllTimers();
    await t.finishInProgressScheduledFunctions();

    results = await t.query(api.runs.leaderboardScores, {});
    expect(results).toHaveLength(0);
  });

  it("caps statistics at 10 most recent runs", async () => {
    const t = convexTest(schema, modules);

    // 12 runs: first 2 score 0 (oldest, should be excluded), then 10 score 1.0
    for (let i = 0; i < 2; i++) {
      await createCompletedRun(t, {
        model: "model-a",
        evals: [
          { category: "cat1", name: "eval1", passed: false },
          { category: "cat1", name: "eval2", passed: false },
        ],
      });
    }
    for (let i = 0; i < 10; i++) {
      await createCompletedRun(t, {
        model: "model-a",
        evals: [
          { category: "cat1", name: "eval1", passed: true },
          { category: "cat1", name: "eval2", passed: true },
        ],
      });
    }

    const results = await t.query(api.runs.leaderboardScores, {});
    expect(results).toHaveLength(1);
    expect(results[0].runCount).toBe(10);

    // Only the 10 most recent runs used, all score 1.0
    expect(results[0].totalScore).toBeCloseTo(1.0);
  });

  it("excludes rate-limited evals from scoring", async () => {
    const t = convexTest(schema, modules);

    await createCompletedRun(t, {
      model: "model-a",
      evals: [
        { category: "cat1", name: "eval1", passed: true },
        { category: "cat1", name: "eval2", rateLimited: true, passed: false },
      ],
    });

    const results = await t.query(api.runs.leaderboardScores, {});
    // Rate-limited eval excluded: 1/1 = 1.0
    expect(results[0].totalScore).toBe(1.0);
  });

  it("stores null cost when no eval has cost data", async () => {
    const t = convexTest(schema, modules);

    await createCompletedRun(t, {
      model: "model-a",
      evals: [{ category: "cat1", name: "eval1", passed: true }],
    });

    const results = await t.query(api.runs.leaderboardScores, {});
    expect(results[0].averageRunCostUsd).toBeNull();
    expect(results[0].averageRunCostUsdErrorBar).toBeNull();
  });

  it("aggregates cost correctly across runs", async () => {
    const t = convexTest(schema, modules);

    await createCompletedRun(t, {
      model: "model-a",
      evals: [
        { category: "cat1", name: "eval1", passed: true, costUsd: 0.5 },
        { category: "cat1", name: "eval2", passed: true, costUsd: 0.5 },
      ],
    });
    await createCompletedRun(t, {
      model: "model-a",
      evals: [
        { category: "cat1", name: "eval1", passed: true, costUsd: 1.5 },
        { category: "cat1", name: "eval2", passed: true, costUsd: 1.5 },
      ],
    });

    const results = await t.query(api.runs.leaderboardScores, {});
    // Run 1 cost = 1.0, Run 2 cost = 3.0 -> mean = 2.0, stddev = 1.0
    expect(results[0].averageRunCostUsd).toBeCloseTo(2.0);
    expect(results[0].averageRunCostUsdErrorBar).toBeCloseTo(1.0);
  });

  it("keeps separate rows per experiment", async () => {
    const t = convexTest(schema, modules);

    await createCompletedRun(t, {
      model: "model-a",
      evals: [{ category: "cat1", name: "eval1", passed: true }],
    });
    await createCompletedRun(t, {
      model: "model-a",
      experiment: "no_guidelines",
      evals: [{ category: "cat1", name: "eval1", passed: false }],
    });

    const defaultRows = await t.query(api.runs.leaderboardScores, {});
    expect(defaultRows).toHaveLength(1);
    expect(defaultRows[0].totalScore).toBe(1.0);

    const expRows = await t.query(api.runs.leaderboardScores, {
      experiment: "no_guidelines",
    });
    expect(expRows).toHaveLength(1);
    expect(expRows[0].totalScore).toBe(0.0);
  });

  it("keeps separate rows per model", async () => {
    const t = convexTest(schema, modules);

    await createCompletedRun(t, {
      model: "model-a",
      formattedName: "Model A",
      evals: [{ category: "cat1", name: "eval1", passed: true }],
    });
    await createCompletedRun(t, {
      model: "model-b",
      formattedName: "Model B",
      evals: [{ category: "cat1", name: "eval1", passed: false }],
    });

    const results = await t.query(api.runs.leaderboardScores, {});
    expect(results).toHaveLength(2);

    const a = results.find((r) => r.model === "model-a");
    const b = results.find((r) => r.model === "model-b");
    expect(a?.totalScore).toBe(1.0);
    expect(b?.totalScore).toBe(0.0);
  });

  it("latestRunId points to the most recent run", async () => {
    const t = convexTest(schema, modules);

    await createCompletedRun(t, {
      model: "model-a",
      evals: [{ category: "cat1", name: "eval1", passed: true }],
    });
    const runId2 = await createCompletedRun(t, {
      model: "model-a",
      evals: [{ category: "cat1", name: "eval1", passed: true }],
    });

    const results = await t.query(api.runs.leaderboardScores, {});
    expect(results[0].latestRunId).toBe(runId2);
  });

  it("excludes runs where not all planned evals completed", async () => {
    const t = convexTest(schema, modules);

    // A ghost run: marked completed but no evals actually finished
    const ghostRunId = await t.mutation(internal.runs.createRun, {
      model: "model-a",
      formattedName: "Model A",
      provider: "test",
      plannedEvals: ["cat1/eval1", "cat1/eval2"],
    });
    await t.mutation(internal.runs.completeRun, {
      runId: ghostRunId,
      status: { kind: "completed", durationMs: 500 },
    });
    vi.runAllTimers();
    await t.finishInProgressScheduledFunctions();

    // Ghost run -> no scored runs -> no row created
    const results = await t.query(api.runs.leaderboardScores, {});
    expect(results).toHaveLength(0);
  });

  it("computes per-category scores and error bars", async () => {
    const t = convexTest(schema, modules);

    await createCompletedRun(t, {
      model: "model-a",
      evals: [
        { category: "cat1", name: "eval1", passed: true },
        { category: "cat1", name: "eval2", passed: false },
        { category: "cat2", name: "eval3", passed: true },
        { category: "cat2", name: "eval4", passed: true },
      ],
    });

    const results = await t.query(api.runs.leaderboardScores, {});
    expect(results[0].scores.cat1).toBe(0.5);
    expect(results[0].scores.cat2).toBe(1.0);
    // One run -> zero error bars
    expect(results[0].scoreErrorBars.cat1).toBe(0);
    expect(results[0].scoreErrorBars.cat2).toBe(0);
    expect(results[0].totalScoreErrorBar).toBe(0);
  });
});
