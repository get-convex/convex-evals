/**
 * Materialised leaderboard scores per (model, experiment) pair.
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

    // Collect unique (modelId, experiment) pairs
    const seen = new Set<string>();
    const pairs: Array<{ modelId: Id<"models">; experiment?: "no_guidelines" | "web_search" | "web_search_no_guidelines" | "agents_md" }> = [];
    for (const run of runs) {
      if (!run.modelId) continue;
      const key = `${run.modelId}|${run.experiment ?? ""}`;
      if (!seen.has(key)) {
        seen.add(key);
        pairs.push({ modelId: run.modelId, experiment: run.experiment });
      }
    }

    for (const pair of pairs) {
      await ctx.scheduler.runAfter(0, internal.modelScores.recomputeModelScores, pair);
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
    const row = await ctx.db
      .query("modelScores")
      .withIndex("by_modelId_experiment", (q) =>
        q.eq("modelId", args.modelId).eq("experiment", args.experiment),
      )
      .unique();

    return row?.latestRunTime ?? null;
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
    const row = await ctx.db
      .query("modelScores")
      .withIndex("by_modelId_experiment", (q) =>
        q.eq("modelId", args.modelId).eq("experiment", args.experiment),
      )
      .unique();

    if (!row) return null;
    return {
      latestRunTime: row.latestRunTime,
      averageRunCostUsd: row.averageRunCostUsd,
    };
  },
});

// ── Core recompute mutation ───────────────────────────────────────────

export const recomputeModelScores = internalMutation({
  args: {
    modelId: v.id("models"),
    experiment: v.optional(experimentLiteral),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    // Fetch the most recent completed runs for this model+experiment.
    // We over-fetch (2x) to account for incomplete/ghost runs that get filtered out.
    const candidateRuns = await ctx.db
      .query("runs")
      .withIndex("by_modelId", (q) => q.eq("modelId", args.modelId))
      .order("desc")
      .take(LEADERBOARD_HISTORY_SIZE * 2);

    const completedRuns = candidateRuns.filter(
      (r) =>
        r.status.kind === "completed" && r.experiment === args.experiment,
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
      .withIndex("by_modelId_experiment", (q) =>
        q.eq("modelId", args.modelId).eq("experiment", args.experiment),
      )
      .unique();

    if (scoredRuns.length === 0) {
      if (existing) await ctx.db.delete(existing._id);
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
    const averageRunCostUsdErrorBar = availableCosts.length > 0 ? costStdDev : null;

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
      await ctx.db.patch(existing._id, row);
    } else {
      await ctx.db.insert("modelScores", row);
    }

    return null;
  },
});
