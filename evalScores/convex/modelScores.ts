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
import { internalMutation } from "./_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api.js";
import { experimentLiteral } from "./schema.js";
import {
  LEADERBOARD_HISTORY_SIZE,
  computeMeanAndStdDev,
  isFullyCompletedRun,
  computeRunCostUsd,
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

    // Collect unique (model, experiment) pairs
    const seen = new Set<string>();
    const pairs: Array<{ model: string; experiment?: "no_guidelines" | "web_search" | "web_search_no_guidelines" | "agents_md" }> = [];
    for (const run of runs) {
      const key = `${run.model}|${run.experiment ?? ""}`;
      if (!seen.has(key)) {
        seen.add(key);
        pairs.push({ model: run.model, experiment: run.experiment });
      }
    }

    for (const pair of pairs) {
      await ctx.scheduler.runAfter(0, internal.modelScores.recomputeModelScores, pair);
    }

    return { queued: pairs.length };
  },
});

// ── Core recompute mutation ───────────────────────────────────────────

export const recomputeModelScores = internalMutation({
  args: {
    model: v.string(),
    experiment: v.optional(experimentLiteral),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    // Fetch the most recent completed runs for this model+experiment.
    // We over-fetch (2x) to account for incomplete/ghost runs that get filtered out.
    const candidateRuns = await ctx.db
      .query("runs")
      .withIndex("by_model", (q) => q.eq("model", args.model))
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
      costUsd: number | null;
    };

    const scoredRuns: ScoredRun[] = [];
    for (const run of completedRuns) {
      if (scoredRuns.length >= LEADERBOARD_HISTORY_SIZE) break;
      const evals = await ctx.db
        .query("evals")
        .withIndex("by_runId", (q) => q.eq("runId", run._id))
        .collect();
      if (!isFullyCompletedRun(run, evals)) continue;
      scoredRuns.push({
        run,
        evals,
        scores: computeRunScores(evals),
        costUsd: computeRunCostUsd(evals),
      });
    }

    // If no scored runs remain (e.g. after deletion), remove the row
    const existing = await ctx.db
      .query("modelScores")
      .withIndex("by_model_experiment", (q) =>
        q.eq("model", args.model).eq("experiment", args.experiment),
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
      model: args.model,
      experiment: args.experiment,
      formattedName: latest.run.formattedName ?? latest.run.model,
      totalScore,
      totalScoreErrorBar,
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
