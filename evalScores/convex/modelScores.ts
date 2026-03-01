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
import { internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { experimentLiteral } from "./schema.js";

const LEADERBOARD_HISTORY_SIZE = 5;

// ── Shared helpers (duplicated from runs.ts to keep this file self-contained) ──

function computeMeanAndStdDev(values: number[]): { mean: number; stdDev: number } {
  if (values.length === 0) return { mean: 0, stdDev: 0 };
  if (values.length === 1) return { mean: values[0], stdDev: 0 };
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  return { mean, stdDev: Math.sqrt(variance) };
}

function isFullyCompletedRun(run: Doc<"runs">, evals: Doc<"evals">[]): boolean {
  const planned = run.plannedEvals.length;
  if (planned === 0) return false;
  const finished = evals.filter(
    (e) => e.status.kind === "passed" || e.status.kind === "failed",
  ).length;
  return finished >= planned;
}

function isRateLimitFailure(evalDoc: Doc<"evals">): boolean {
  if (evalDoc.status.kind !== "failed") return false;
  return evalDoc.status.failureReason.startsWith("[rate_limit]");
}

function getEvalCostUsd(evalDoc: Doc<"evals">): number {
  const status = evalDoc.status;
  if (status.kind !== "passed" && status.kind !== "failed") return 0;
  const rawUsage = status.usage?.raw;
  if (!rawUsage || typeof rawUsage !== "object") return 0;
  if (!("cost" in rawUsage)) return 0;
  const cost = (rawUsage as { cost?: unknown }).cost;
  return typeof cost === "number" && Number.isFinite(cost) ? cost : 0;
}

function computeRunCostUsd(evals: Doc<"evals">[]): number | null {
  const terminal = evals.filter(
    (e) => e.status.kind === "passed" || e.status.kind === "failed",
  );
  const withCost = terminal.filter((e) => {
    const status = e.status;
    if (status.kind !== "passed" && status.kind !== "failed") return false;
    const raw = status.usage?.raw;
    return (
      raw !== undefined &&
      raw !== null &&
      typeof raw === "object" &&
      "cost" in raw &&
      typeof (raw as { cost?: unknown }).cost === "number"
    );
  });
  if (withCost.length === 0) return null;
  return withCost.reduce((sum, e) => sum + getEvalCostUsd(e), 0);
}

function computeRunScores(
  evals: Doc<"evals">[],
): { totalScore: number; scores: Record<string, number> } {
  const completed = evals.filter(
    (e) =>
      (e.status.kind === "passed" || e.status.kind === "failed") &&
      !isRateLimitFailure(e),
  );
  if (completed.length === 0) return { totalScore: 0, scores: {} };

  const byCategory = new Map<string, { passed: number; total: number }>();
  let totalPassed = 0;
  for (const e of completed) {
    const cat = e.category;
    const existing = byCategory.get(cat) ?? { passed: 0, total: 0 };
    existing.total++;
    if (e.status.kind === "passed") {
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
    totalScore: completed.length > 0 ? totalPassed / completed.length : 0,
    scores,
  };
}

// ── Internal query: used by the backfill migration ────────────────────

export const getAllModelExperimentPairs = internalQuery({
  args: {},
  returns: v.array(
    v.object({
      model: v.string(),
      experiment: v.optional(experimentLiteral),
    }),
  ),
  handler: async (ctx) => {
    const experiments = await ctx.db.query("experiments").collect();
    const pairs: Array<{ model: string; experiment?: "no_guidelines" | "web_search" | "web_search_no_guidelines" | "agents_md" }> = [];
    for (const exp of experiments) {
      const expValue = exp.name === "default" ? undefined : exp.name as "no_guidelines" | "web_search" | "web_search_no_guidelines" | "agents_md";
      for (const model of exp.models) {
        pairs.push({ model, experiment: expValue });
      }
    }
    return pairs;
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
    const sixtyDaysAgo = Date.now() - 60 * 24 * 60 * 60 * 1000;

    // Fetch recent completed runs for this model, matching experiment
    const candidateRuns = await ctx.db
      .query("runs")
      .withIndex("by_model", (q) =>
        q.eq("model", args.model).gte("_creationTime", sixtyDaysAgo),
      )
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
