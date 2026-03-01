import { internalMutation, query } from "./_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { experimentLiteral, languageModelUsage, runStatus, evalStatus } from "./schema.js";
import { internal } from "./_generated/api.js";

/** Number of recent runs used for stdDev in scheduling stats */
const LEADERBOARD_HISTORY_SIZE = 5;

/** Maximum age of runs to include in leaderboard queries (60 days in ms) */
const LEADERBOARD_MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000;

function computeMeanAndStdDev(values: number[]): { mean: number; stdDev: number } {
  if (values.length === 0) return { mean: 0, stdDev: 0 };
  if (values.length === 1) return { mean: values[0], stdDev: 0 };
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return { mean, stdDev: Math.sqrt(variance) };
}

export const createRun = internalMutation({
  args: {
    model: v.string(),
    formattedName: v.string(),
    provider: v.string(),
    runId: v.optional(v.string()),
    plannedEvals: v.array(v.string()),
    experiment: v.optional(experimentLiteral),
  },
  returns: v.id("runs"),
  handler: async (ctx, args) => {
    const now = Date.now();
    const expName = args.experiment ?? "default";
    
    // Create the run
    const id = await ctx.db.insert("runs", {
      model: args.model,
      formattedName: args.formattedName,
      provider: args.provider,
      runId: args.runId,
      plannedEvals: args.plannedEvals,
      status: { kind: "pending" },
      experiment: args.experiment,
    });
    
    // Update experiment stats
    const existing = await ctx.db
      .query("experiments")
      .withIndex("by_name", (q) => q.eq("name", expName))
      .unique();
    
    if (existing) {
      const models = existing.models.includes(args.model)
        ? existing.models
        : [...existing.models, args.model];
      await ctx.db.patch(existing._id, {
        runCount: existing.runCount + 1,
        models,
        latestRunTime: now,
      });
    } else {
      await ctx.db.insert("experiments", {
        name: expName,
        runCount: 1,
        completedRuns: 0,
        totalEvals: 0,
        passedEvals: 0,
        models: [args.model],
        latestRunTime: now,
      });
    }
    
    return id;
  },
});

export const updateRunStatus = internalMutation({
  args: {
    runId: v.id("runs"),
    status: runStatus,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch(args.runId, {
      status: args.status,
    });
    return null;
  },
});

export const completeRun = internalMutation({
  args: {
    runId: v.id("runs"),
    status: v.union(
      v.object({ kind: v.literal("completed"), durationMs: v.number(), usage: v.optional(languageModelUsage) }),
      v.object({ kind: v.literal("failed"), failureReason: v.string(), durationMs: v.number(), usage: v.optional(languageModelUsage) }),
    ),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run) return null;
    
    await ctx.db.patch(args.runId, {
      status: args.status,
    });
    
    // Update experiment completed run count
    const expName = run.experiment ?? "default";
    const experiment = await ctx.db
      .query("experiments")
      .withIndex("by_name", (q) => q.eq("name", expName))
      .unique();
    
    if (experiment && args.status.kind === "completed") {
      await ctx.db.patch(experiment._id, {
        completedRuns: experiment.completedRuns + 1,
      });
    }

    // Schedule a recompute of the materialised leaderboard row for this model
    await ctx.scheduler.runAfter(0, internal.modelScores.recomputeModelScores, {
      model: run.model,
      experiment: run.experiment,
    });
    
    return null;
  },
});

export const deleteRun = internalMutation({
  args: {
    runId: v.id("runs"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run) return null;

    // Collect all evals for this run
    const evals = await ctx.db
      .query("evals")
      .withIndex("by_runId", (q) => q.eq("runId", args.runId))
      .collect();

    // Track stats for experiment counter adjustment
    const totalEvalsCount = evals.length;
    let passedEvalsCount = 0;
    const storageIdsToDelete = new Set<string>();

    for (const evalDoc of evals) {
      if (evalDoc.status.kind === "passed") passedEvalsCount++;

      // Collect storage IDs from evals
      if (evalDoc.status.kind === "passed" || evalDoc.status.kind === "failed") {
        const status = evalDoc.status;
        if ("outputStorageId" in status && status.outputStorageId) {
          storageIdsToDelete.add(status.outputStorageId);
        }
      }
      if (evalDoc.status.kind === "running" && evalDoc.status.outputStorageId) {
        storageIdsToDelete.add(evalDoc.status.outputStorageId);
      }
      if (evalDoc.evalSourceStorageId) {
        // Don't delete eval source — it's shared/deduped across runs
      }

      // Delete all steps for this eval
      const steps = await ctx.db
        .query("steps")
        .withIndex("by_evalId", (q) => q.eq("evalId", evalDoc._id))
        .collect();
      for (const step of steps) {
        await ctx.db.delete(step._id);
      }

      // Delete the eval
      await ctx.db.delete(evalDoc._id);
    }

    // Delete associated storage files (output zips)
    for (const storageId of storageIdsToDelete) {
      await ctx.storage.delete(storageId as Id<"_storage">);
    }

    // Update experiment stats
    const expName = run.experiment ?? "default";
    const experiment = await ctx.db
      .query("experiments")
      .withIndex("by_name", (q) => q.eq("name", expName))
      .unique();

    if (experiment) {
      const wasCompleted =
        run.status.kind === "completed" || run.status.kind === "failed";
      await ctx.db.patch(experiment._id, {
        runCount: Math.max(0, experiment.runCount - 1),
        completedRuns: Math.max(
          0,
          experiment.completedRuns - (wasCompleted ? 1 : 0),
        ),
        totalEvals: Math.max(0, experiment.totalEvals - totalEvalsCount),
        passedEvals: Math.max(0, experiment.passedEvals - passedEvalsCount),
      });
    }

    // Delete the run itself
    await ctx.db.delete(args.runId);

    // Recompute the leaderboard row for this model now that a run is gone
    await ctx.scheduler.runAfter(0, internal.modelScores.recomputeModelScores, {
      model: run.model,
      experiment: run.experiment,
    });

    return null;
  },
});

export const getRunDetails = query({
  args: {
    runId: v.id("runs"),
  },
  returns: v.union(
    v.object({
      _id: v.id("runs"),
      model: v.string(),
      provider: v.string(),
      runId: v.optional(v.string()),
      plannedEvals: v.array(v.string()),
      status: runStatus,
      experiment: v.optional(experimentLiteral),
      _creationTime: v.number(),
      evals: v.array(
        v.object({
          _id: v.id("evals"),
          runId: v.id("runs"),
          evalPath: v.string(),
          category: v.string(),
          name: v.string(),
          status: evalStatus,
          task: v.optional(v.string()),
          evalSourceStorageId: v.optional(v.id("_storage")),
          _creationTime: v.number(),
          steps: v.array(
            v.object({
              _id: v.id("steps"),
              evalId: v.id("evals"),
              name: v.union(
                v.literal("filesystem"),
                v.literal("install"),
                v.literal("deploy"),
                v.literal("tsc"),
                v.literal("eslint"),
                v.literal("tests"),
              ),
              status: v.union(
                v.object({ kind: v.literal("running") }),
                v.object({ kind: v.literal("passed"), durationMs: v.number() }),
                v.object({ kind: v.literal("failed"), failureReason: v.string(), durationMs: v.number() }),
                v.object({ kind: v.literal("skipped") }),
              ),
              _creationTime: v.number(),
            }),
          ),
        }),
      ),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run) return null;

    const evals = await ctx.db
      .query("evals")
      .withIndex("by_runId", (q) => q.eq("runId", args.runId))
      .collect();

    const evalsWithSteps = await Promise.all(
      evals.map(async (evalItem) => {
        const steps = await ctx.db
          .query("steps")
          .withIndex("by_evalId", (q) => q.eq("evalId", evalItem._id))
          .collect();
        return {
          _id: evalItem._id,
          runId: evalItem.runId,
          evalPath: evalItem.evalPath,
          category: evalItem.category,
          name: evalItem.name,
          status: evalItem.status,
          task: evalItem.task,
          evalSourceStorageId: evalItem.evalSourceStorageId,
          _creationTime: evalItem._creationTime,
          steps: steps.map((step) => ({
            _id: step._id,
            evalId: step.evalId,
            name: step.name,
            status: step.status,
            _creationTime: step._creationTime,
          })),
        };
      }),
    );

    return {
      _id: run._id,
      model: run.model,
      provider: run.provider,
      runId: run.runId,
      plannedEvals: run.plannedEvals,
      status: run.status,
      experiment: run.experiment,
      _creationTime: run._creationTime,
      evals: evalsWithSteps,
    };
  },
});

// Get a download URL for an output file
export const getOutputUrl = query({
  args: {
    storageId: v.id("_storage"),
  },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    const url = await ctx.storage.getUrl(args.storageId);
    return url;
  },
});

// List all runs with optional filtering
export const listRuns = query({
  args: {
    experiment: v.optional(experimentLiteral),
    model: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    let runsQuery = ctx.db.query("runs").order("desc");
    
    // Apply filters if provided
    if (args.experiment) {
      runsQuery = ctx.db
        .query("runs")
        .withIndex("by_experiment", (q) => q.eq("experiment", args.experiment))
        .order("desc");
    } else if (args.model) {
      const model = args.model;
      runsQuery = ctx.db
        .query("runs")
        .withIndex("by_model", (q) => q.eq("model", model))
        .order("desc");
    }
    
    // This query also loads eval documents per returned run to compute counts.
    // Cap the run count to keep total bytes read below Convex function limits.
    const MAX_LIST_RUNS_LIMIT = 40;
    const requestedLimit = args.limit ?? 100;
    const limit = Math.min(Math.max(requestedLimit, 1), MAX_LIST_RUNS_LIMIT);
    const runs = await runsQuery.take(limit);
    
    // Fetch eval counts for each run
    const runsWithCounts = await Promise.all(
      runs.map(async (run) => {
        const evals = await ctx.db
          .query("evals")
          .withIndex("by_runId", (q) => q.eq("runId", run._id))
          .collect();
        
        const passedCount = evals.filter((e) => e.status.kind === "passed").length;
        const failedCount = evals.filter((e) => e.status.kind === "failed").length;
        const totalCount = evals.length;
        
        return {
          ...run,
          evalCounts: {
            total: totalCount,
            passed: passedCount,
            failed: failedCount,
            pending: totalCount - passedCount - failedCount,
          },
        };
      }),
    );
    
    return runsWithCounts;
  },
});

// List all experiments with their denormalized stats
export const listExperiments = query({
  args: {},
  handler: async (ctx) => {
    const experiments = await ctx.db.query("experiments").collect();
    
    // Transform to expected format and sort by latest run
    const result = experiments.map((exp) => ({
      name: exp.name,
      runCount: exp.runCount,
      modelCount: exp.models.length,
      models: exp.models,
      latestRun: exp.latestRunTime,
      totalEvals: exp.totalEvals,
      passedEvals: exp.passedEvals,
      passRate: exp.totalEvals > 0 ? exp.passedEvals / exp.totalEvals : 0,
      completedRuns: exp.completedRuns,
    }));
    
    // Sort by latest run (most recent first)
    result.sort((a, b) => b.latestRun - a.latestRun);
    
    return result;
  },
});

// ── Leaderboard queries (computed from runs + evals) ─────────────────

/**
 * Check whether a run is "fully completed": all planned evals have a
 * terminal status (passed or failed). Runs where some evals are still
 * pending/running are considered incomplete and should be excluded from
 * leaderboard computations.
 */
function isFullyCompletedRun(
  run: Doc<"runs">,
  evals: Doc<"evals">[],
): boolean {
  const planned = run.plannedEvals.length;
  if (planned === 0) return false; // degenerate case

  // An eval is "finished" if it has a terminal status (passed or failed).
  // Rate-limit failures still count as finished so the run can complete.
  const finished = evals.filter(
    (e) => e.status.kind === "passed" || e.status.kind === "failed",
  ).length;

  return finished >= planned;
}

/** Check if a failed eval was caused by a rate-limit / infrastructure error. */
function isRateLimitFailure(evalDoc: Doc<"evals">): boolean {
  if (evalDoc.status.kind !== "failed") return false;
  return evalDoc.status.failureReason.startsWith("[rate_limit]");
}

/**
 * Compute scores for a single run from its evals.
 * Used by leaderboardModelHistory (per-run, not aggregated).
 */
function computeRunScoresFromEvals(
  evals: Doc<"evals">[],
): { totalScore: number; scores: Record<string, number> } {
  const completedEvals = evals.filter(
    (e) =>
      (e.status.kind === "passed" || e.status.kind === "failed") &&
      !isRateLimitFailure(e),
  );

  if (completedEvals.length === 0) return { totalScore: 0, scores: {} };

  const byCategory = new Map<string, { passed: number; total: number }>();
  let totalPassed = 0;

  for (const evalItem of completedEvals) {
    const cat = evalItem.category;
    const existing = byCategory.get(cat) ?? { passed: 0, total: 0 };
    existing.total++;
    if (evalItem.status.kind === "passed") {
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
    totalScore: completedEvals.length > 0 ? totalPassed / completedEvals.length : 0,
    scores,
  };
}

/**
 * Lists all models with their mean scores and standard deviations.
 * Reads directly from the materialised modelScores table, which is kept
 * up-to-date by the recomputeModelScores scheduled mutation.
 */
export const leaderboardScores = query({
  args: {
    experiment: v.optional(experimentLiteral),
  },
  returns: v.array(
    v.object({
      model: v.string(),
      formattedName: v.string(),
      totalScore: v.number(),
      totalScoreErrorBar: v.number(),
      averageRunCostUsd: v.union(v.number(), v.null()),
      averageRunCostUsdErrorBar: v.union(v.number(), v.null()),
      scores: v.record(v.string(), v.number()),
      scoreErrorBars: v.record(v.string(), v.number()),
      runCount: v.number(),
      latestRunId: v.id("runs"),
      latestRunTime: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("modelScores")
      .withIndex("by_experiment", (q) => q.eq("experiment", args.experiment))
      .collect();

    // Sort by total score descending (highest first), then by model name for ties
    rows.sort((a, b) => b.totalScore - a.totalScore || a.model.localeCompare(b.model));

    return rows.map((r) => ({
      model: r.model,
      formattedName: r.formattedName,
      totalScore: r.totalScore,
      totalScoreErrorBar: r.totalScoreErrorBar,
      averageRunCostUsd: r.averageRunCostUsd,
      averageRunCostUsdErrorBar: r.averageRunCostUsdErrorBar,
      scores: r.scores,
      scoreErrorBars: r.scoreErrorBars,
      runCount: r.runCount,
      latestRunId: r.latestRunId,
      latestRunTime: r.latestRunTime,
    }));
  },
});

/**
 * Gets historical run data for a specific model, ordered chronologically (oldest first).
 * Computed on-demand from the runs and evals tables.
 * Useful for displaying time-series charts of model performance over time.
 */
export const leaderboardModelHistory = query({
  args: {
    model: v.string(),
    experiment: v.optional(experimentLiteral),
    limit: v.optional(v.number()),
  },
  returns: v.array(
    v.object({
      _creationTime: v.number(),
      runId: v.id("runs"),
      totalScore: v.number(),
      scores: v.record(v.string(), v.number()),
    }),
  ),
  handler: async (ctx, args) => {
    // Fetch runs for this model, limited to last 60 days, ordered chronologically
    const sixtyDaysAgo = Date.now() - LEADERBOARD_MAX_AGE_MS;
    let runs = await ctx.db
      .query("runs")
      .withIndex("by_model", (q) =>
        q.eq("model", args.model).gte("_creationTime", sixtyDaysAgo))
      .order("asc")
      .collect();

    // Filter by experiment
    if (args.experiment !== undefined) {
      runs = runs.filter((run) => run.experiment === args.experiment);
    } else {
      // If no experiment specified, only get runs without experiment tag
      runs = runs.filter((run) => run.experiment === undefined);
    }

    // Only include completed runs
    runs = runs.filter((r) => r.status.kind === "completed");

    // Fetch evals and filter to only fully-completed runs, computing scores
    type HistoryResult = {
      _creationTime: number;
      runId: Id<"runs">;
      totalScore: number;
      scores: Record<string, number>;
    };
    const results: HistoryResult[] = [];
    await Promise.all(
      runs.map(async (run) => {
        const evals = await ctx.db
          .query("evals")
          .withIndex("by_runId", (q) => q.eq("runId", run._id))
          .collect();
        if (!isFullyCompletedRun(run, evals)) return;
        const { totalScore, scores } = computeRunScoresFromEvals(evals);
        results.push({
          _creationTime: run._creationTime,
          runId: run._id,
          totalScore,
          scores,
        });
      }),
    );

    // Re-sort chronologically since async may shuffle order
    results.sort((a, b) => a._creationTime - b._creationTime);

    // Apply limit if provided (take from the end since we want recent data)
    if (args.limit !== undefined && args.limit > 0) {
      return results.slice(-args.limit);
    }

    return results;
  },
});

// ── Visualiser queries ───────────────────────────────────────────────

/** Max runs to fetch per model (index-backed, bounded) */
const LIST_MODELS_RUNS_PER_MODEL = 20;

/** Max recent runs to use for pass rate calculation per model */
const LIST_MODELS_EVALS_RUNS = 3;

// List models with aggregated stats. Uses by_model index for bounded queries.
// Caller must pass model names (e.g. derived from experiments.models).
export const listModels = query({
  args: { models: v.array(v.string()) },
  handler: async (ctx, args) => {
    if (args.models.length === 0) return [];

    const modelStats = new Map<string, {
      runCount: number;
      experiments: Set<string>;
      latestRunTime: number;
      runIds: Id<"runs">[];
    }>();

    for (const modelName of args.models) {
      const runs = await ctx.db
        .query("runs")
        .withIndex("by_model", (q) => q.eq("model", modelName))
        .order("desc")
        .take(LIST_MODELS_RUNS_PER_MODEL);

      if (runs.length === 0) continue;

      const experiments = new Set<string>();
      const runIds: Id<"runs">[] = [];
      let latestRunTime = 0;

      for (const run of runs) {
        experiments.add(run.experiment ?? "default");
        runIds.push(run._id);
        if (run._creationTime > latestRunTime) {
          latestRunTime = run._creationTime;
        }
      }

      modelStats.set(modelName, {
        runCount: runs.length,
        experiments,
        latestRunTime,
        runIds,
      });
    }

    // Fetch eval counts for pass rate calculation (most recent 3 runs per model)
    const result = await Promise.all(
      Array.from(modelStats.entries()).map(async ([model, stats]) => {
        let totalEvals = 0;
        let passedEvals = 0;

        const recentRunIds = stats.runIds.slice(0, LIST_MODELS_EVALS_RUNS);
        for (const runId of recentRunIds) {
          const evals = await ctx.db
            .query("evals")
            .withIndex("by_runId", (q) => q.eq("runId", runId))
            .collect();

          const scorable = evals.filter((e) => !isRateLimitFailure(e));
          totalEvals += scorable.length;
          passedEvals += scorable.filter((e) => e.status.kind === "passed").length;
        }

        return {
          name: model,
          runCount: stats.runCount,
          experimentCount: stats.experiments.size,
          experiments: Array.from(stats.experiments),
          latestRun: stats.latestRunTime,
          totalEvals,
          passedEvals,
          passRate: totalEvals > 0 ? passedEvals / totalEvals : 0,
        };
      })
    );

    result.sort((a, b) => b.latestRun - a.latestRun);
    return result;
  },
});

// ── Scheduling stats ─────────────────────────────────────────────────

/**
 * Returns per-model scheduling data used to compute dynamic CI run intervals.
 *
 * - completedRunCount: all-time count of completed default-experiment runs
 * - scoreStdDev: population stdDev of total scores from the last LEADERBOARD_HISTORY_SIZE runs
 * - lastRunTime: _creationTime of the most recent completed run (null if none)
 * - firstRunTime: _creationTime of the oldest run ever recorded (null if none)
 */
export const getSchedulingStats = query({
  args: { models: v.array(v.string()) },
  returns: v.array(
    v.object({
      model: v.string(),
      completedRunCount: v.number(),
      scoreStdDev: v.number(),
      lastRunTime: v.union(v.number(), v.null()),
      firstRunTime: v.union(v.number(), v.null()),
    }),
  ),
  handler: async (ctx, args) => {
    const results: Array<{
      model: string;
      completedRunCount: number;
      scoreStdDev: number;
      lastRunTime: number | null;
      firstRunTime: number | null;
    }> = [];

    for (const modelName of args.models) {
      // Fetch all runs for this model (no time cap) ordered newest first
      const allRuns = await ctx.db
        .query("runs")
        .withIndex("by_model", (q) => q.eq("model", modelName))
        .order("desc")
        .collect();

      if (allRuns.length === 0) {
        results.push({
          model: modelName,
          completedRunCount: 0,
          scoreStdDev: 0,
          lastRunTime: null,
          firstRunTime: null,
        });
        continue;
      }

      // Only default-experiment completed runs count toward scheduling
      const completedDefaultRuns = allRuns.filter(
        (r) => r.status.kind === "completed" && r.experiment === undefined,
      );

      const completedRunCount = completedDefaultRuns.length;
      const lastRunTime =
        completedDefaultRuns.length > 0
          ? completedDefaultRuns[0]._creationTime
          : null;

      // firstRunTime from ALL runs (oldest ever, regardless of experiment)
      const firstRunTime = allRuns[allRuns.length - 1]._creationTime;

      // Compute stdDev from the most recent LEADERBOARD_HISTORY_SIZE completed default runs
      let scoreStdDev = 0;
      if (completedDefaultRuns.length >= 2) {
        const recentRuns = completedDefaultRuns.slice(
          0,
          LEADERBOARD_HISTORY_SIZE,
        );
        const scores: number[] = [];
        for (const run of recentRuns) {
          const evals = await ctx.db
            .query("evals")
            .withIndex("by_runId", (q) => q.eq("runId", run._id))
            .collect();
          if (!isFullyCompletedRun(run, evals)) continue;
          const { totalScore } = computeRunScoresFromEvals(evals);
          scores.push(totalScore);
        }
        if (scores.length >= 2) {
          const { stdDev } = computeMeanAndStdDev(scores);
          scoreStdDev = stdDev;
        }
      }

      results.push({
        model: modelName,
        completedRunCount,
        scoreStdDev,
        lastRunTime,
        firstRunTime,
      });
    }

    return results;
  },
});
