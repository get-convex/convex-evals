/**
 * Materialised leaderboard scores per (model, experiment, benchmark) group.
 *
 * The `recomputeModelScores` mutation is scheduled whenever a run completes
 * or is deleted. It fetches the last LEADERBOARD_HISTORY_SIZE fully-completed
 * runs for the given model + experiment, recomputes all aggregate stats, and
 * upserts the corresponding row in the modelScores table.
 *
 * The leaderboardScores query in runs.ts reads directly from this table
 * rather than recomputing on every request.
 */
import { internalMutation, query } from "./_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api.js";
import { experimentLiteral } from "./schema.js";
import {
  LEADERBOARD_HISTORY_SIZE,
  computeMeanAndStdDev,
  isFullyCompletedRun,
  hasCompleteBenchmarkPlan,
  computeRunCostUsd,
  computeRunDurationMs,
  computeRunScores,
} from "./scoringUtils.js";

// ── One-shot backfill action ──────────────────────────────────────────

/**
 * Scans all completed runs, collects unique (model, experiment) pairs,
 * and calls recomputeModelScores for each one.
 *
 * Run against dev:  npx convex run modelScores:backfillAllModelScores
 * Run against prod: npx convex run modelScores:backfillAllModelScores --prod
 */
export const backfillAllModelScores = internalMutation({
  args: {},
  returns: v.object({ queued: v.number() }),
  handler: async (ctx) => {
    const runs = await ctx.db
      .query("runs")
      .filter((q) => q.eq(q.field("status.kind"), "completed"))
      .collect();
    const benchmarks = await ctx.db.query("benchmarkVersions").collect();
    const benchmarkById = new Map(
      benchmarks.map((benchmark) => [benchmark._id, benchmark]),
    );

    // Collect unique (modelId, experiment, benchmarkVersion) groups.
    const seen = new Set<string>();
    const pairs: Array<{
      modelId: Id<"models">;
      experiment?:
        | "no_guidelines"
        | "web_search"
        | "web_search_no_guidelines"
        | "agents_md";
      benchmarkVersion: Id<"benchmarkVersions">;
    }> = [];
    for (const run of runs) {
      if (!run.modelId) continue;
      const benchmarkVersion = run.benchmarkVersion;
      const benchmark = benchmarkById.get(benchmarkVersion);
      if (!hasCompleteBenchmarkPlan(run, benchmark?.evalCount)) continue;
      const key = `${run.modelId}|${run.experiment ?? ""}|${benchmarkVersion}`;
      if (!seen.has(key)) {
        seen.add(key);
        pairs.push({
          modelId: run.modelId,
          experiment: run.experiment,
          benchmarkVersion,
        });
      }
    }

    for (const pair of pairs) {
      await ctx.scheduler.runAfter(
        0,
        internal.modelScores.recomputeModelScores,
        pair,
      );
    }

    return { queued: pairs.length };
  },
});

export const getLatestRunTime = query({
  args: {
    modelId: v.id("models"),
    experiment: v.optional(experimentLiteral),
  },
  returns: v.union(v.number(), v.null()),
  handler: async (ctx, args) => {
    // This is a scheduling-oriented compatibility query, so it deliberately
    // spans benchmark versions. Minting a new suite must not make every
    // model appear to have never run.
    const rows = await ctx.db
      .query("modelScores")
      .withIndex("by_modelId_experiment", (q) =>
        q.eq("modelId", args.modelId).eq("experiment", args.experiment),
      )
      .collect();

    return rows.reduce<number | null>(
      (latest, row) =>
        latest === null || row.latestRunTime > latest
          ? row.latestRunTime
          : latest,
      null,
    );
  },
});

export const getSchedulingStats = query({
  args: {
    modelId: v.id("models"),
    experiment: v.optional(experimentLiteral),
  },
  returns: v.union(
    v.object({
      latestRunTime: v.number(),
      averageRunCostUsd: v.union(v.number(), v.null()),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const latestRuns = await ctx.db
      .query("runs")
      .withIndex("by_modelId", (q) => q.eq("modelId", args.modelId))
      .order("desc")
      .take(50);
    const latestAttempt = latestRuns.find(
      (run) => run.experiment === args.experiment,
    );

    const rows = await ctx.db
      .query("modelScores")
      .withIndex("by_modelId_experiment", (q) =>
        q.eq("modelId", args.modelId).eq("experiment", args.experiment),
      )
      .collect();
    const row = rows.sort((a, b) => b.latestRunTime - a.latestRunTime)[0];
    const latestRunTime = latestAttempt?._creationTime ?? row?.latestRunTime;

    if (latestRunTime === undefined) return null;
    return {
      latestRunTime,
      averageRunCostUsd: row?.averageRunCostUsd ?? null,
    };
  },
});

// ── Core recompute mutation ───────────────────────────────────────────

export const recomputeModelScores = internalMutation({
  args: {
    modelId: v.id("models"),
    experiment: v.optional(experimentLiteral),
    benchmarkVersion: v.id("benchmarkVersions"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const benchmark = await ctx.db.get(args.benchmarkVersion);
    if (!benchmark) return null;

    // The composite index narrows this to one model/experiment/version, then
    // status and the minted suite size exclude incomplete and filtered runs.
    const candidateRuns = await ctx.db
      .query("runs")
      .withIndex("by_modelId_experiment_benchmark", (q) =>
        q
          .eq("modelId", args.modelId)
          .eq("experiment", args.experiment)
          .eq("benchmarkVersion", args.benchmarkVersion),
      )
      .filter((q) => q.eq(q.field("status.kind"), "completed"))
      .order("desc")
      .collect();

    const completedRuns = candidateRuns.filter(
      (r) =>
        r.status.kind === "completed" &&
        hasCompleteBenchmarkPlan(r, benchmark?.evalCount),
    );

    // Score each run, stopping once we have enough
    type ScoredRun = {
      run: Doc<"runs">;
      evals: Doc<"evals">[];
      scores: ReturnType<typeof computeRunScores>;
      durationMs: number;
      costUsd: number | null;
    };

    const scoredRuns: ScoredRun[] = [];
    for (const run of completedRuns) {
      if (scoredRuns.length >= LEADERBOARD_HISTORY_SIZE) break;
      if (run.status.kind !== "completed") continue;
      const evals = await ctx.db
        .query("evals")
        .withIndex("by_runId", (q) => q.eq("runId", run._id))
        .collect();
      if (!isFullyCompletedRun(run, evals)) continue;
      const durationMs = computeRunDurationMs(evals);
      if (durationMs === null || durationMs <= 0) continue;
      scoredRuns.push({
        run,
        evals,
        scores: computeRunScores(evals),
        durationMs,
        costUsd: computeRunCostUsd(evals),
      });
    }

    // If no scored runs remain (e.g. after deletion), remove the row
    const existing = await ctx.db
      .query("modelScores")
      .withIndex("by_modelId_experiment_benchmark", (q) =>
        q
          .eq("modelId", args.modelId)
          .eq("experiment", args.experiment)
          .eq("benchmarkVersion", args.benchmarkVersion),
      )
      .unique();

    if (scoredRuns.length === 0) {
      if (existing) await ctx.db.delete("modelScores", existing._id);
      return null;
    }

    // Compute aggregates
    const latest = scoredRuns[0];
    const { mean: totalScore, stdDev: totalScoreErrorBar } =
      computeMeanAndStdDev(scoredRuns.map((sr) => sr.scores.totalScore));
    const { mean: averageRunDurationMs, stdDev: averageRunDurationMsErrorBar } =
      computeMeanAndStdDev(scoredRuns.map((sr) => sr.durationMs));

    const availableCosts = scoredRuns
      .map((sr) => sr.costUsd)
      .filter((c): c is number => c !== null);
    const { mean: costMean, stdDev: costStdDev } =
      computeMeanAndStdDev(availableCosts);
    const averageRunCostUsd = availableCosts.length > 0 ? costMean : null;
    const averageRunCostUsdErrorBar =
      availableCosts.length > 0 ? costStdDev : null;

    const allCategories = new Set<string>();
    for (const sr of scoredRuns) {
      for (const cat of Object.keys(sr.scores.scores)) allCategories.add(cat);
    }

    const scores: Record<string, number> = {};
    const scoreErrorBars: Record<string, number> = {};
    for (const cat of allCategories) {
      const catScores = scoredRuns
        .map((sr) => sr.scores.scores[cat])
        .filter((s): s is number => s !== undefined);
      const { mean, stdDev } = computeMeanAndStdDev(catScores);
      scores[cat] = mean;
      scoreErrorBars[cat] = stdDev;
    }

    const row = {
      modelId: args.modelId,
      experiment: args.experiment,
      benchmarkVersion: args.benchmarkVersion,
      totalScore,
      totalScoreErrorBar,
      averageRunDurationMs,
      averageRunDurationMsErrorBar,
      averageRunCostUsd,
      averageRunCostUsdErrorBar,
      scores,
      scoreErrorBars,
      runCount: scoredRuns.length,
      latestRunId: latest.run._id as Id<"runs">,
      latestRunTime: latest.run._creationTime,
    };

    if (existing) {
      await ctx.db.patch("modelScores", existing._id, row);
    } else {
      await ctx.db.insert("modelScores", row);
    }

    return null;
  },
});

/**
 * Rebuild score partitions after run benchmark IDs have been migrated. The
 * rows are derived data, so deleting and recomputing them is safer than trying
 * to assign an old aggregate that may span multiple historical suites.
 */
export const rebuildAllModelScores = internalMutation({
  args: {},
  returns: v.object({ deleted: v.number() }),
  handler: async (ctx) => {
    const rows = await ctx.db.query("modelScores").collect();
    for (const row of rows) await ctx.db.delete("modelScores", row._id);
    await ctx.scheduler.runAfter(
      0,
      internal.modelScores.backfillAllModelScores,
      {},
    );
    return { deleted: rows.length };
  },
});
