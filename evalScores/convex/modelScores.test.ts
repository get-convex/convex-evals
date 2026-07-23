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
 * - Infrastructure failures are excluded from scoring
 */
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  backfillCompletedRunsToBenchmark,
  consolidateCompletedBenchmarkRuns,
} from "./benchmarkVersions";
import schema from "./schema";
import { modules } from "./test.setup";

// Prevent scheduled functions from firing asynchronously and causing
// "write outside of transaction" errors.
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

// ── Test helper ───────────────────────────────────────────────────────

async function createCompletedRun(
  t: ReturnType<typeof convexTest>,
  opts: {
    model: string;
    formattedName?: string;
    experiment?: "no_guidelines";
    benchmarkVersion?: string;
    evals: Array<{
      category: string;
      name: string;
      passed: boolean;
      rateLimited?: boolean;
      infrastructureFailure?: boolean;
      costUsd?: number;
      durationMs?: number;
      generationDurationMs?: number;
    }>;
    runDurationMs?: number;
  },
): Promise<Id<"runs">> {
  if (opts.benchmarkVersion === undefined) {
    await t.mutation(internal.benchmarkVersions.mint, {
      version: `test-suite-${opts.evals.length}`,
      evalCount: opts.evals.length,
      curatedModels: [opts.model],
    });
  }
  const runId = await t.mutation(internal.runs.createRun, {
    model: opts.model,
    formattedName: opts.formattedName ?? opts.model,
    provider: "test",
    plannedEvals: opts.evals.map((e) => `${e.category}/${e.name}`),
    experiment: opts.experiment,
    benchmarkVersion:
      opts.benchmarkVersion ?? `test-suite-${opts.evals.length}`,
  });

  for (const evalDef of opts.evals) {
    const evalId = await t.mutation(internal.evals.createEval, {
      runId,
      evalPath: `${evalDef.category}/${evalDef.name}`,
      category: evalDef.category,
      name: evalDef.name,
    });

    const usage =
      evalDef.costUsd !== undefined
        ? { raw: { cost: evalDef.costUsd } }
        : undefined;

    if (evalDef.rateLimited || evalDef.infrastructureFailure) {
      await t.mutation(internal.evals.completeEval, {
        evalId,
        status: {
          kind: "failed" as const,
          failureReason: evalDef.rateLimited
            ? "[rate_limit] 429 too many requests"
            : "[infrastructure] empty provider response",
          durationMs: evalDef.durationMs ?? 100,
          generationDurationMs: evalDef.generationDurationMs,
          usage,
        },
      });
    } else if (evalDef.passed) {
      await t.mutation(internal.evals.completeEval, {
        evalId,
        status: {
          kind: "passed" as const,
          durationMs: evalDef.durationMs ?? 1000,
          generationDurationMs: evalDef.generationDurationMs,
          usage,
        },
      });
    } else {
      await t.mutation(internal.evals.completeEval, {
        evalId,
        status: {
          kind: "failed" as const,
          failureReason: "test failure",
          durationMs: evalDef.durationMs ?? 1000,
          generationDurationMs: evalDef.generationDurationMs,
          usage,
        },
      });
    }
  }

  await t.mutation(internal.runs.completeRun, {
    runId,
    status: {
      kind: "completed",
      durationMs: opts.runDurationMs ?? 5000,
    },
  });

  // Advance fake time past the 0ms mark so recomputeModelScores fires
  vi.runAllTimers();
  await t.finishInProgressScheduledFunctions();

  return runId;
}

async function createFailedRun(
  t: ReturnType<typeof convexTest>,
  opts: {
    model: string;
    formattedName?: string;
    experiment?: "no_guidelines";
    failureReason?: string;
  },
): Promise<Id<"runs">> {
  const runId = await t.mutation(internal.runs.createRun, {
    model: opts.model,
    formattedName: opts.formattedName ?? opts.model,
    provider: "test",
    plannedEvals: ["cat1/eval1"],
    experiment: opts.experiment,
  });

  await t.mutation(internal.runs.completeRun, {
    runId,
    status: {
      kind: "failed",
      failureReason:
        opts.failureReason ??
        "[infrastructure] [zero_tokens] Zero total token usage detected",
      durationMs: 5000,
    },
  });

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
    expect(results[0].averageRunDurationMs).toBe(1000);
  });

  it("uses mean generation runtime instead of wall-clock or scoring runtime", async () => {
    const t = convexTest(schema, modules);

    await createCompletedRun(t, {
      model: "model-a",
      runDurationMs: 50_000,
      evals: [
        {
          category: "cat1",
          name: "eval1",
          passed: true,
          durationMs: 4000,
          generationDurationMs: 30_000,
        },
        {
          category: "cat1",
          name: "eval2",
          passed: false,
          durationMs: 2000,
          generationDurationMs: 20_000,
        },
      ],
    });

    const results = await t.query(api.runs.leaderboardScores, {});
    expect(results).toHaveLength(1);
    expect(results[0].averageRunDurationMs).toBe(25_000);
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

    const runId = await createCompletedRun(t, {
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

  it("excludes infrastructure eval failures from scoring", async () => {
    const t = convexTest(schema, modules);

    await createCompletedRun(t, {
      model: "model-a",
      evals: [
        { category: "cat1", name: "eval1", passed: true },
        {
          category: "cat1",
          name: "eval2",
          infrastructureFailure: true,
          passed: false,
        },
      ],
    });

    const results = await t.query(api.runs.leaderboardScores, {});
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

  it("shows only the current minted benchmark and preserves older versions in the archive", async () => {
    const t = convexTest(schema, modules);

    await t.mutation(internal.benchmarkVersions.mint, {
      version: "benchmark-v1",
      evalCount: 1,
      curatedModels: ["model-a"],
    });
    await createCompletedRun(t, {
      model: "model-a",
      benchmarkVersion: "benchmark-v1",
      evals: [{ category: "cat1", name: "eval1", passed: true }],
    });

    await t.mutation(internal.benchmarkVersions.mint, {
      version: "benchmark-v2",
      evalCount: 1,
      curatedModels: ["model-a"],
    });
    await createCompletedRun(t, {
      model: "model-a",
      benchmarkVersion: "benchmark-v2",
      evals: [{ category: "cat1", name: "eval1", passed: false }],
    });

    const current = await t.query(api.runs.leaderboardScores, {
      benchmarkVersion: "benchmark-v2",
    });
    expect(current).toHaveLength(1);
    expect(current[0].benchmarkVersion).toBe("benchmark-v2");
    expect(current[0].totalScore).toBe(0);

    const archived = await t.query(api.runs.leaderboardScores, {
      benchmarkVersion: "benchmark-v1",
    });
    expect(archived).toHaveLength(1);
    expect(archived[0].totalScore).toBe(1);
    const archivedHistory = await t.query(api.runs.leaderboardModelHistory, {
      model: "model-a",
      benchmarkVersion: "benchmark-v1",
    });
    expect(archivedHistory).toHaveLength(1);
    expect(archivedHistory[0].totalScore).toBe(1);

    const versions = await t.query(api.runs.leaderboardVersions, {});
    expect(versions.map((version) => version.version)).toEqual([
      "benchmark-v2",
      "benchmark-v1",
      "all",
    ]);
    expect(versions[0]).toMatchObject({
      isCurrent: true,
      curatedModelCount: 1,
      curatedModelsScored: 1,
    });

    const originalMintedTime = versions[0].mintedAt;
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    await t.mutation(internal.benchmarkVersions.mint, {
      version: "benchmark-v2",
      evalCount: 1,
      curatedModels: ["model-a", "model-b"],
    });
    const repeatedMint = await t.query(api.runs.leaderboardVersions, {});
    expect(repeatedMint[0].mintedAt).toBe(originalMintedTime);
    expect(repeatedMint[0].curatedModelCount).toBe(2);
  });

  it("keeps a newly minted benchmark visible before its first score", async () => {
    const t = convexTest(schema, modules);

    await t.mutation(internal.benchmarkVersions.mint, {
      version: "new-empty-benchmark",
      evalCount: 2,
      curatedModels: ["model-a"],
    });

    expect(await t.query(api.runs.leaderboardVersions, {})).toEqual([
      expect.objectContaining({
        version: "new-empty-benchmark",
        modelCount: 0,
        isCurrent: true,
      }),
      expect.objectContaining({ version: "all", benchmarkCount: 1 }),
    ]);
  });

  it("backfills explicitly selected completed runs after a benchmark is minted", async () => {
    const t = convexTest(schema, modules);

    const runId = await createCompletedRun(t, {
      model: "model-a",
      benchmarkVersion: "not-yet-minted-suite-hash",
      evals: [{ category: "cat1", name: "eval1", passed: true }],
    });
    await t.mutation(internal.benchmarkVersions.mint, {
      version: "new-benchmark",
      evalCount: 1,
      curatedModels: ["model-a"],
    });

    expect(await t.query(api.runs.leaderboardScores, {})).toEqual([]);

    await expect(
      t.run(async (ctx) =>
        backfillCompletedRunsToBenchmark(ctx, {
          version: "new-benchmark",
          runIds: [runId],
        }),
      ),
    ).resolves.toEqual({
      updated: 1,
      alreadyAssigned: 0,
      scoreGroupsQueued: 1,
    });
    vi.runAllTimers();
    await t.finishInProgressScheduledFunctions();

    const results = await t.query(api.runs.leaderboardScores, {});
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      model: "model-a",
      benchmarkVersion: "new-benchmark",
      runCount: 1,
      totalScore: 1,
    });

    await expect(
      t.run(async (ctx) =>
        backfillCompletedRunsToBenchmark(ctx, {
          version: "new-benchmark",
          runIds: [runId],
        }),
      ),
    ).resolves.toEqual({
      updated: 0,
      alreadyAssigned: 1,
      scoreGroupsQueued: 1,
    });
  });

  it("consolidates multiple historical runs into the matching minted benchmark", async () => {
    const t = convexTest(schema, modules);

    await t.run(async (ctx) => {
      await ctx.db.insert("benchmarkVersions", {
        version: "reconstructed-suite",
        effectiveAt: 1,
        evalCount: 1,
        curatedModels: [],
        provenance: "reconstructed",
      });
    });
    await t.mutation(internal.benchmarkVersions.mint, {
      version: "minted-suite",
      evalCount: 1,
      curatedModels: ["model-a"],
    });

    const historicalPass = await createCompletedRun(t, {
      model: "model-a",
      benchmarkVersion: "reconstructed-suite",
      evals: [{ category: "cat1", name: "eval1", passed: true }],
    });
    const historicalFail = await createCompletedRun(t, {
      model: "model-a",
      benchmarkVersion: "reconstructed-suite",
      evals: [{ category: "cat1", name: "eval1", passed: false }],
    });
    await createCompletedRun(t, {
      model: "model-a",
      benchmarkVersion: "minted-suite",
      evals: [{ category: "cat1", name: "eval1", passed: true }],
    });

    await expect(
      t.run(async (ctx) =>
        consolidateCompletedBenchmarkRuns(ctx, {
          sourceVersion: "reconstructed-suite",
          targetVersion: "minted-suite",
          runIds: [historicalPass, historicalFail],
        }),
      ),
    ).resolves.toEqual({
      updated: 2,
      alreadyAssigned: 0,
      scoreGroupsQueued: 1,
    });
    vi.runAllTimers();
    await t.finishInProgressScheduledFunctions();

    const combined = await t.query(api.runs.leaderboardScores, {
      benchmarkVersion: "minted-suite",
    });
    expect(combined).toHaveLength(1);
    expect(combined[0]).toMatchObject({
      runCount: 3,
      totalScore: 2 / 3,
    });
    expect(
      await t.query(api.runs.leaderboardScores, {
        benchmarkVersion: "reconstructed-suite",
      }),
    ).toEqual([]);
    expect(
      (await t.query(api.runs.leaderboardVersions, {})).map(
        (version) => version.version,
      ),
    ).toEqual(["minted-suite", "all"]);

    await expect(
      t.run(async (ctx) =>
        consolidateCompletedBenchmarkRuns(ctx, {
          sourceVersion: "reconstructed-suite",
          targetVersion: "minted-suite",
          runIds: [historicalPass, historicalFail],
        }),
      ),
    ).resolves.toEqual({
      updated: 0,
      alreadyAssigned: 2,
      scoreGroupsQueued: 1,
    });
  });

  it("refuses to backfill a failed run", async () => {
    const t = convexTest(schema, modules);

    await t.mutation(internal.benchmarkVersions.mint, {
      version: "new-benchmark",
      evalCount: 1,
      curatedModels: ["model-a"],
    });
    const runId = await t.mutation(internal.runs.createRun, {
      model: "model-a",
      formattedName: "Model A",
      provider: "test",
      plannedEvals: ["cat1/eval1"],
      benchmarkVersion: "not-yet-minted-suite-hash",
    });
    await t.mutation(internal.runs.completeRun, {
      runId,
      status: {
        kind: "failed",
        failureReason: "rate limited",
        durationMs: 1000,
      },
    });

    await expect(
      t.run(async (ctx) =>
        backfillCompletedRunsToBenchmark(ctx, {
          version: "new-benchmark",
          runIds: [runId],
        }),
      ),
    ).rejects.toThrow(`Run ${runId} is not completed`);
  });

  it("combines all public benchmark versions with run-weighted statistics", async () => {
    const t = convexTest(schema, modules);

    vi.setSystemTime(new Date("2026-04-01T00:00:00Z"));
    await t.mutation(internal.benchmarkVersions.mint, {
      version: "benchmark-v1",
      evalCount: 1,
      curatedModels: ["model-a"],
    });
    await createCompletedRun(t, {
      model: "model-a",
      benchmarkVersion: "benchmark-v1",
      evals: [
        {
          category: "cat1",
          name: "eval1",
          passed: true,
          costUsd: 1,
          durationMs: 1000,
        },
      ],
    });

    vi.setSystemTime(new Date("2026-04-02T00:00:00Z"));
    await t.mutation(internal.benchmarkVersions.mint, {
      version: "benchmark-v2",
      evalCount: 1,
      curatedModels: ["model-a"],
    });
    await createCompletedRun(t, {
      model: "model-a",
      benchmarkVersion: "benchmark-v2",
      evals: [
        {
          category: "cat1",
          name: "eval1",
          passed: false,
          costUsd: 3,
          durationMs: 3000,
        },
      ],
    });

    const allScores = await t.query(api.runs.leaderboardScores, {
      benchmarkVersion: "all",
    });
    expect(allScores).toHaveLength(1);
    expect(allScores[0]).toMatchObject({
      benchmarkVersion: "all",
      model: "model-a",
      runCount: 2,
      totalScore: 0.5,
      totalScoreErrorBar: 0.5,
      averageRunDurationMs: 2000,
      averageRunDurationMsErrorBar: 1000,
      averageRunCostUsd: 2,
      averageRunCostUsdErrorBar: 1,
      scores: { cat1: 0.5 },
      scoreErrorBars: { cat1: 0.5 },
    });

    const allHistory = await t.query(api.runs.leaderboardModelHistory, {
      model: "model-a",
      benchmarkVersion: "all",
    });
    expect(allHistory.map((entry) => entry.totalScore)).toEqual([1, 0]);

    const versions = await t.query(api.runs.leaderboardVersions, {});
    expect(versions.find((version) => version.version === "all")).toMatchObject(
      {
        benchmarkCount: 2,
        modelCount: 1,
        isAll: true,
      },
    );
  });

  it("uses the current benchmark when the site omits a version", async () => {
    const t = convexTest(schema, modules);

    await createCompletedRun(t, {
      model: "old-model",
      evals: [{ category: "cat1", name: "eval1", passed: true }],
    });
    expect(await t.query(api.runs.leaderboardScores, {})).toHaveLength(1);

    await t.mutation(internal.benchmarkVersions.mint, {
      version: "new-benchmark",
      evalCount: 2,
      curatedModels: ["new-model"],
    });

    expect(await t.query(api.runs.leaderboardScores, {})).toEqual([]);
    expect(
      await t.query(api.runs.leaderboardScores, {
        benchmarkVersion: "new-benchmark",
      }),
    ).toEqual([]);
    const archived = await t.query(api.runs.leaderboardScores, {
      benchmarkVersion: "test-suite-1",
    });
    expect(archived).toHaveLength(1);
    expect(archived[0].model).toBe("old-model");
  });

  it("does not score filtered runs as full benchmark results", async () => {
    const t = convexTest(schema, modules);

    await t.mutation(internal.benchmarkVersions.mint, {
      version: "full-suite",
      evalCount: 2,
      curatedModels: ["model-a"],
    });
    await createCompletedRun(t, {
      model: "model-a",
      benchmarkVersion: "full-suite",
      evals: [{ category: "cat1", name: "eval1", passed: true }],
    });

    expect(await t.query(api.runs.leaderboardScores, {})).toEqual([]);
  });

  it("does not score a benchmark before it is manually minted", async () => {
    const t = convexTest(schema, modules);

    await createCompletedRun(t, {
      model: "model-a",
      benchmarkVersion: "candidate-suite",
      evals: [{ category: "cat1", name: "eval1", passed: true }],
    });

    expect(
      await t.query(api.runs.leaderboardScores, {
        benchmarkVersion: "candidate-suite",
      }),
    ).toEqual([]);
    expect(await t.query(api.runs.leaderboardVersions, {})).toEqual([]);
  });

  it("returns latest run time for the requested experiment only", async () => {
    const t = convexTest(schema, modules);

    vi.setSystemTime(new Date("2026-04-01T00:00:00Z"));
    await createCompletedRun(t, {
      model: "model-a",
      evals: [{ category: "cat1", name: "eval1", passed: true }],
    });

    const defaultRows = await t.query(api.runs.leaderboardScores, {});
    const modelId = defaultRows[0].modelId;
    const defaultLatestRunTime = defaultRows[0].latestRunTime;

    vi.setSystemTime(new Date("2026-04-02T00:00:00Z"));
    await createCompletedRun(t, {
      model: "model-a",
      experiment: "no_guidelines",
      evals: [{ category: "cat1", name: "eval1", passed: false }],
    });

    const latestDefaultRunTime = await t.query(
      api.modelScores.getLatestRunTime,
      {
        modelId,
      },
    );
    expect(latestDefaultRunTime).toBe(defaultLatestRunTime);

    const latestNoGuidelinesRunTime = await t.query(
      api.modelScores.getLatestRunTime,
      {
        modelId,
        experiment: "no_guidelines",
      },
    );
    expect(latestNoGuidelinesRunTime).not.toBeNull();
    expect(latestNoGuidelinesRunTime).toBeGreaterThan(defaultLatestRunTime);
  });

  it("uses failed attempts for scheduling cooldown without changing leaderboard scores", async () => {
    const t = convexTest(schema, modules);

    vi.setSystemTime(new Date("2026-04-01T00:00:00Z"));
    await createCompletedRun(t, {
      model: "model-a",
      evals: [{ category: "cat1", name: "eval1", passed: true, costUsd: 2 }],
    });

    const before = await t.query(api.runs.leaderboardScores, {});
    const modelId = before[0].modelId;
    const scoredLatestRunId = before[0].latestRunId;
    const scoredLatestRunTime = before[0].latestRunTime;

    vi.setSystemTime(new Date("2026-04-02T00:00:00Z"));
    await createFailedRun(t, { model: "model-a" });

    const schedulingStats = await t.query(api.modelScores.getSchedulingStats, {
      modelId,
    });
    expect(schedulingStats?.latestRunTime).toBeGreaterThan(scoredLatestRunTime);
    expect(schedulingStats?.averageRunCostUsd).toBe(2);

    const after = await t.query(api.runs.leaderboardScores, {});
    expect(after[0].latestRunId).toBe(scoredLatestRunId);
    expect(after[0].runCount).toBe(1);
    expect(after[0].totalScore).toBe(1);
  });

  it("returns scheduling stats for failed-only models", async () => {
    const t = convexTest(schema, modules);

    vi.setSystemTime(new Date("2026-04-03T00:00:00Z"));
    await createFailedRun(t, { model: "model-a" });

    const model = await t.query(api.models.getBySlug, { slug: "model-a" });
    expect(model).not.toBeNull();
    const runs = await t.query(api.runs.listRuns, { limit: 1 });

    const schedulingStats = await t.query(api.modelScores.getSchedulingStats, {
      modelId: model!._id,
    });
    expect(schedulingStats?.latestRunTime).toBe(runs[0]._creationTime);
    expect(schedulingStats?.averageRunCostUsd).toBeNull();

    const leaderboard = await t.query(api.runs.leaderboardScores, {});
    expect(leaderboard).toHaveLength(0);
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

    const a = results.find((r: { model: string }) => r.model === "model-a");
    const b = results.find((r: { model: string }) => r.model === "model-b");
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
