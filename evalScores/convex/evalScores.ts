import { internalMutation, query } from "./_generated/server";
import { v } from "convex/values";

const HISTORY_SIZE = 5;

/**
 * Records scores for a model run. Always inserts a new record (append-only).
 */
export const updateScores = internalMutation({
  args: {
    model: v.string(),
    scores: v.record(v.string(), v.number()),
    totalScore: v.number(),
    runId: v.optional(v.string()),
  },
  returns: v.id("evalScores"),
  handler: async (ctx, args) => {
    const id = await ctx.db.insert("evalScores", {
      model: args.model,
      scores: args.scores,
      totalScore: args.totalScore,
      runId: args.runId,
    });
    return id;
  },
});

/**
 * Retrieves the latest scores for a specific model.
 */
export const getScores = query({
  args: {
    model: v.string(),
  },
  returns: v.union(
    v.object({
      _id: v.id("evalScores"),
      model: v.string(),
      totalScore: v.number(),
      scores: v.record(v.string(), v.number()),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const scores = await ctx.db
      .query("evalScores")
      .withIndex("by_model", (q) => q.eq("model", args.model))
      .order("desc")
      .first();

    return scores;
  },
});

function computeStdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const squaredDiffs = values.map((v) => (v - mean) ** 2);
  const variance = squaredDiffs.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(variance);
}

/**
 * Lists all models with their latest scores and error bars.
 * Error bars are ± standard deviation computed from the last N runs.
 */
export const listAllScores = query({
  args: {},
  returns: v.array(
    v.object({
      model: v.string(),
      totalScore: v.number(),
      totalScoreErrorBar: v.number(),
      scores: v.record(v.string(), v.number()),
      scoreErrorBars: v.record(v.string(), v.number()),
      runCount: v.number(),
      latestRunId: v.optional(v.string()),
      latestRunTime: v.number(),
    }),
  ),
  handler: async (ctx) => {
    const allScores = await ctx.db.query("evalScores").collect();

    // Group by model
    const byModel = new Map<string, typeof allScores>();
    for (const score of allScores) {
      const existing = byModel.get(score.model) ?? [];
      existing.push(score);
      byModel.set(score.model, existing);
    }

    const results: Array<{
      model: string;
      totalScore: number;
      totalScoreErrorBar: number;
      scores: Record<string, number>;
      scoreErrorBars: Record<string, number>;
      runCount: number;
      latestRunId: string | undefined;
      latestRunTime: number;
    }> = [];

    for (const [model, runs] of byModel) {
      // Sort by creation time descending, take last N
      const sorted = runs.sort((a, b) => b._creationTime - a._creationTime);
      const recentRuns = sorted.slice(0, HISTORY_SIZE);
      const latest = recentRuns[0];

      // Compute error bar for totalScore
      const totalScores = recentRuns.map((r) => r.totalScore);
      const totalScoreErrorBar = computeStdDev(totalScores);

      // Compute error bars for each category
      const allCategories = new Set<string>();
      for (const run of recentRuns) {
        for (const cat of Object.keys(run.scores)) {
          allCategories.add(cat);
        }
      }

      const scoreErrorBars: Record<string, number> = {};
      for (const cat of allCategories) {
        const catScores = recentRuns
          .map((r) => r.scores[cat])
          .filter((s): s is number => s !== undefined);
        scoreErrorBars[cat] = computeStdDev(catScores);
      }

      results.push({
        model,
        totalScore: latest.totalScore,
        totalScoreErrorBar,
        scores: latest.scores,
        scoreErrorBars,
        runCount: runs.length,
        latestRunId: latest.runId,
        latestRunTime: latest._creationTime,
      });
    }

    // Sort by model name for consistent ordering
    results.sort((a, b) => a.model.localeCompare(b.model));

    return results;
  },
});
