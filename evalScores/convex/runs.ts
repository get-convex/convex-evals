import { internalMutation, query } from "./_generated/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { experimentLiteral, languageModelUsage, evalStatus } from "./schema.js";
import { internal } from "./_generated/api.js";
import {
  LEADERBOARD_MAX_AGE_MS,
  isFullyCompletedRun,
  isRateLimitFailure,
  computeRunScores,
} from "./scoringUtils.js";

export const createRun = internalMutation({
  args: {
    modelId: v.optional(v.id("models")),
    model: v.optional(v.string()),
    formattedName: v.optional(v.string()),
    openRouterFirstSeenAt: v.optional(v.number()),
    provider: v.string(),
    runId: v.optional(v.string()),
    plannedEvals: v.array(v.string()),
    experiment: v.optional(experimentLiteral),
  },
  returns: v.id("runs"),
  handler: async (ctx, args) => {
    const now = Date.now();
    const expName = args.experiment ?? "default";
    let modelId = args.modelId;

    if (!modelId) {
      if (!args.model) {
        throw new Error("createRun requires either modelId or model slug");
      }
      const existingModel = await ctx.db
        .query("models")
        .withIndex("by_slug", (q) => q.eq("slug", args.model!))
        .unique();
      if (existingModel) {
        modelId = existingModel._id;
      } else {
        const provider =
          args.model.includes("/") ? args.model.split("/")[0] : args.provider;
        const apiKind =
          args.model.startsWith("openai/") && args.model.includes("codex")
            ? "responses"
            : "chat";
        modelId = await ctx.db.insert("models", {
          slug: args.model,
          formattedName: args.formattedName ?? args.model,
          provider,
          apiKind,
          openRouterFirstSeenAt: args.openRouterFirstSeenAt ?? now,
          createdAt: now,
          updatedAt: now,
          lastSeenAt: now,
        });
      }
    }
    if (!modelId) {
      throw new Error("Failed to resolve modelId");
    }
    
    // Create the run
    const id = await ctx.db.insert("runs", {
      modelId,
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
      const models = existing.models.includes(modelId)
        ? existing.models
        : [...existing.models, modelId];
      await ctx.db.patch("experiments", existing._id, {
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
        models: [modelId],
        latestRunTime: now,
      });
    }
    
    return id;
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
    const run = await ctx.db.get("runs", args.runId);
    if (!run) return null;
    
    await ctx.db.patch("runs", args.runId, {
      status: args.status,
    });
    
    // Update experiment completed run count
    const expName = run.experiment ?? "default";
    const experiment = await ctx.db
      .query("experiments")
      .withIndex("by_name", (q) => q.eq("name", expName))
      .unique();
    
    if (experiment && args.status.kind === "completed") {
      await ctx.db.patch("experiments", experiment._id, {
        completedRuns: experiment.completedRuns + 1,
      });
    }

    // Schedule a recompute of the materialised leaderboard row for this model
    if (run.modelId) {
      await ctx.scheduler.runAfter(0, internal.modelScores.recomputeModelScores, {
        modelId: run.modelId,
        experiment: run.experiment,
      });
    }
    
    return null;
  },
});

export const deleteRun = internalMutation({
  args: {
    runId: v.id("runs"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const run = await ctx.db.get("runs", args.runId);
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
        await ctx.db.delete("steps", step._id);
      }

      // Delete the eval
      await ctx.db.delete("evals", evalDoc._id);
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
      await ctx.db.patch("experiments", experiment._id, {
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
    await ctx.db.delete("runs", args.runId);

    // Recompute the leaderboard row for this model now that a run is gone
    if (run.modelId) {
      await ctx.scheduler.runAfter(0, internal.modelScores.recomputeModelScores, {
        modelId: run.modelId,
        experiment: run.experiment,
      });
    }

    return null;
  },
});

export const getRunDetails = query({
  args: {
    runId: v.id("runs"),
  },
  handler: async (ctx, args) => {
    const run = await ctx.db.get("runs", args.runId);
    if (!run) return null;
    const model = run.modelId ? await ctx.db.get("models", run.modelId) : null;

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
      modelId: run.modelId,
      model:
        model && "slug" in model
          ? model.slug
          : "unknown-model",
      formattedName:
        model && "formattedName" in model
          ? model.formattedName
          : "Unknown model",
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
    modelId: v.optional(v.id("models")),
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
    } else if (args.modelId) {
      const modelId = args.modelId;
      runsQuery = ctx.db
        .query("runs")
        .withIndex("by_modelId", (q) => q.eq("modelId", modelId))
        .order("desc");
    }
    
    // This query also loads eval documents per returned run to compute counts.
    // Cap the run count to keep total bytes read below Convex function limits.
    const MAX_LIST_RUNS_LIMIT = 40;
    const requestedLimit = args.limit ?? 100;
    const limit = Math.min(Math.max(requestedLimit, 1), MAX_LIST_RUNS_LIMIT);
    const runs = await runsQuery.take(limit);
    
    // Fetch eval counts for each run
    const models = await ctx.db.query("models").collect();
    const modelMap = new Map(models.map((m) => [m._id, m] as const));
    const runsWithCounts = await Promise.all(
      runs.map(async (run) => {
        const evals = await ctx.db
          .query("evals")
          .withIndex("by_runId", (q) => q.eq("runId", run._id))
          .collect();
        
        const passedCount = evals.filter((e) => e.status.kind === "passed").length;
        const failedCount = evals.filter((e) => e.status.kind === "failed").length;
        const totalCount = evals.length;
        
        const model = modelMap.get(run.modelId);
        return {
          ...run,
          model: model?.slug ?? "unknown-model",
          formattedName: model?.formattedName ?? "Unknown model",
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
      modelIds: exp.models,
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
 * Lists all models with their mean scores and standard deviations.
 * Reads directly from the materialised modelScores table, which is kept
 * up-to-date by the recomputeModelScores scheduled mutation.
 */
export const leaderboardScores = query({
  args: {
    experiment: v.optional(experimentLiteral),
  },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("modelScores")
      .withIndex("by_experiment", (q) => q.eq("experiment", args.experiment))
      .collect();
    const models = await ctx.db.query("models").collect();
    const modelMap = new Map(models.map((m) => [m._id, m] as const));

    // Sort by total score descending (highest first), then by model name for ties
    rows.sort((a, b) => {
      const modelA = modelMap.get(a.modelId)?.slug ?? "";
      const modelB = modelMap.get(b.modelId)?.slug ?? "";
      return b.totalScore - a.totalScore || modelA.localeCompare(modelB);
    });

    return rows.map((r) => ({
      modelId: r.modelId,
      model: modelMap.get(r.modelId)?.slug ?? "unknown-model",
      formattedName: modelMap.get(r.modelId)?.formattedName ?? "Unknown model",
      openRouterFirstSeenAt:
        modelMap.get(r.modelId)?.openRouterFirstSeenAt ?? 0,
      totalScore: r.totalScore,
      totalScoreErrorBar: r.totalScoreErrorBar,
      averageRunDurationMs: r.averageRunDurationMs,
      averageRunDurationMsErrorBar: r.averageRunDurationMsErrorBar,
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
    modelId: v.optional(v.id("models")),
    model: v.optional(v.string()),
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
    let targetModelId = args.modelId;
    if (!targetModelId && args.model) {
      const modelDoc = await ctx.db
        .query("models")
        .withIndex("by_slug", (q) => q.eq("slug", args.model!))
        .unique();
      targetModelId = modelDoc?._id;
    }
    if (!targetModelId) {
      return [];
    }

    // Fetch runs for this model, limited to last 60 days, ordered chronologically
    const sixtyDaysAgo = Date.now() - LEADERBOARD_MAX_AGE_MS;
    let runs = await ctx.db
      .query("runs")
      .withIndex("by_modelId", (q) =>
        q.eq("modelId", targetModelId).gte("_creationTime", sixtyDaysAgo))
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
        const { totalScore, scores } = computeRunScores(evals);
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
const MODEL_SUMMARY_RUNS_PER_MODEL = 20;

/** Max recent runs to use for pass rate calculation per model */
const MODEL_SUMMARY_EVALS_RUNS = 3;

export const getModelSummary = query({
  args: { modelId: v.id("models") },
  handler: async (ctx, args) => {
    const runs = await ctx.db
      .query("runs")
      .withIndex("by_modelId", (q) => q.eq("modelId", args.modelId))
      .order("desc")
      .take(MODEL_SUMMARY_RUNS_PER_MODEL);

    if (runs.length === 0) {
      return {
        runCount: 0,
        experimentCount: 0,
        totalEvals: 0,
        passedEvals: 0,
        passRate: 0,
      };
    }

    const experiments = new Set<string>();
    let totalEvals = 0;
    let passedEvals = 0;

    for (const run of runs) {
      experiments.add(run.experiment ?? "default");
    }

    for (const run of runs.slice(0, MODEL_SUMMARY_EVALS_RUNS)) {
      const evals = await ctx.db
        .query("evals")
        .withIndex("by_runId", (q) => q.eq("runId", run._id))
        .collect();

      const scorable = evals.filter((e) => !isRateLimitFailure(e));
      totalEvals += scorable.length;
      passedEvals += scorable.filter((e) => e.status.kind === "passed").length;
    }

    return {
      runCount: runs.length,
      experimentCount: experiments.size,
      totalEvals,
      passedEvals,
      passRate: totalEvals > 0 ? passedEvals / totalEvals : 0,
    };
  },
});

export const getLatestRunTime = query({
  args: { modelId: v.id("models") },
  handler: async (ctx, args) => {
    const latestRun = await ctx.db
      .query("runs")
      .withIndex("by_modelId", (q) => q.eq("modelId", args.modelId))
      .order("desc")
      .first();

    return latestRun?._creationTime ?? null;
  },
});

