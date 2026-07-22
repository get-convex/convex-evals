import { internalMutation, query, type QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { experimentLiteral, languageModelUsage, evalStatus } from "./schema.js";
import { internal } from "./_generated/api.js";
import { resolveBenchmarkForRun } from "./benchmarkVersions";
import {
  LEADERBOARD_HISTORY_SIZE,
  isFullyCompletedRun,
  hasCompleteBenchmarkPlan,
  isRateLimitFailure,
  computeRunScores,
} from "./scoringUtils.js";

const ALL_BENCHMARK_VERSIONS = "all";

type ScoreSummary = {
  mean: number;
  stdDev: number;
  count: number;
};

type LeaderboardScoreRow = Pick<
  Doc<"modelScores">,
  | "modelId"
  | "totalScore"
  | "totalScoreErrorBar"
  | "averageRunDurationMs"
  | "averageRunDurationMsErrorBar"
  | "averageRunCostUsd"
  | "averageRunCostUsdErrorBar"
  | "scores"
  | "scoreErrorBars"
  | "runCount"
  | "latestRunId"
  | "latestRunTime"
>;

/**
 * Combine population means and standard deviations without loading raw runs.
 * modelScores stores population standard deviation, so this reconstructs the
 * same aggregate as pooling its contributing runs directly.
 */
function combineSummaries(summaries: ScoreSummary[]): {
  mean: number;
  stdDev: number;
} | null {
  const usable = summaries.filter((summary) => summary.count > 0);
  const count = usable.reduce((total, summary) => total + summary.count, 0);
  if (count === 0) return null;

  const mean =
    usable.reduce((total, summary) => total + summary.mean * summary.count, 0) /
    count;
  const variance =
    usable.reduce(
      (total, summary) =>
        total +
        summary.count * (summary.stdDev ** 2 + (summary.mean - mean) ** 2),
      0,
    ) / count;
  return { mean, stdDev: Math.sqrt(variance) };
}

function combineModelScoreRows(
  rows: Doc<"modelScores">[],
): LeaderboardScoreRow {
  const latest = rows.reduce((current, row) =>
    row.latestRunTime > current.latestRunTime ? row : current,
  );
  const totalScore = combineSummaries(
    rows.map((row) => ({
      mean: row.totalScore,
      stdDev: row.totalScoreErrorBar,
      count: row.runCount,
    })),
  )!;
  const duration = combineSummaries(
    rows.map((row) => ({
      mean: row.averageRunDurationMs,
      stdDev: row.averageRunDurationMsErrorBar,
      count: row.runCount,
    })),
  )!;
  const cost = combineSummaries(
    rows.flatMap((row) =>
      row.averageRunCostUsd === null || row.averageRunCostUsdErrorBar === null
        ? []
        : [
            {
              mean: row.averageRunCostUsd,
              stdDev: row.averageRunCostUsdErrorBar,
              count: row.runCount,
            },
          ],
    ),
  );

  const categories = new Set(rows.flatMap((row) => Object.keys(row.scores)));
  const scores: Record<string, number> = {};
  const scoreErrorBars: Record<string, number> = {};
  for (const category of categories) {
    const combined = combineSummaries(
      rows.flatMap((row) =>
        row.scores[category] === undefined
          ? []
          : [
              {
                mean: row.scores[category],
                stdDev: row.scoreErrorBars[category] ?? 0,
                count: row.runCount,
              },
            ],
      ),
    );
    if (!combined) continue;
    scores[category] = combined.mean;
    scoreErrorBars[category] = combined.stdDev;
  }

  return {
    modelId: latest.modelId,
    totalScore: totalScore.mean,
    totalScoreErrorBar: totalScore.stdDev,
    averageRunDurationMs: duration.mean,
    averageRunDurationMsErrorBar: duration.stdDev,
    averageRunCostUsd: cost?.mean ?? null,
    averageRunCostUsdErrorBar: cost?.stdDev ?? null,
    scores,
    scoreErrorBars,
    runCount: rows.reduce((total, row) => total + row.runCount, 0),
    latestRunId: latest.latestRunId,
    latestRunTime: latest.latestRunTime,
  };
}

async function getCurrentBenchmark(
  ctx: Pick<QueryCtx, "db">,
): Promise<Doc<"benchmarkVersions"> | null> {
  const publicVersions = await ctx.db
    .query("benchmarkVersions")
    .withIndex("by_effectiveAt")
    .order("desc")
    .collect();
  return (
    publicVersions.find((version) => version.provenance !== "unminted") ?? null
  );
}

export const createRun = internalMutation({
  args: {
    modelId: v.optional(v.id("models")),
    model: v.optional(v.string()),
    formattedName: v.optional(v.string()),
    openRouterFirstSeenAt: v.optional(v.number()),
    provider: v.string(),
    runId: v.optional(v.string()),
    plannedEvals: v.array(v.string()),
    benchmarkVersion: v.optional(v.string()),
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
        const provider = args.model.includes("/")
          ? args.model.split("/")[0]
          : args.provider;
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
    const benchmarkVersion = await resolveBenchmarkForRun(
      ctx,
      args.benchmarkVersion,
    );

    // Create the run
    const id = await ctx.db.insert("runs", {
      modelId,
      provider: args.provider,
      runId: args.runId,
      plannedEvals: args.plannedEvals,
      benchmarkVersion,
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
      v.object({
        kind: v.literal("completed"),
        durationMs: v.number(),
        usage: v.optional(languageModelUsage),
      }),
      v.object({
        kind: v.literal("failed"),
        failureReason: v.string(),
        durationMs: v.number(),
        usage: v.optional(languageModelUsage),
      }),
    ),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const run = await ctx.db.get("runs", args.runId);
    if (!run) return null;
    const benchmarkVersion = run.benchmarkVersion;

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
      await ctx.scheduler.runAfter(
        0,
        internal.modelScores.recomputeModelScores,
        {
          modelId: run.modelId,
          experiment: run.experiment,
          benchmarkVersion,
        },
      );
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
    const benchmarkVersion = run.benchmarkVersion;

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
      if (
        evalDoc.status.kind === "passed" ||
        evalDoc.status.kind === "failed"
      ) {
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
      await ctx.scheduler.runAfter(
        0,
        internal.modelScores.recomputeModelScores,
        {
          modelId: run.modelId,
          experiment: run.experiment,
          benchmarkVersion,
        },
      );
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
      model: model && "slug" in model ? model.slug : "unknown-model",
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

        const passedCount = evals.filter(
          (e) => e.status.kind === "passed",
        ).length;
        const failedCount = evals.filter(
          (e) => e.status.kind === "failed",
        ).length;
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
    benchmarkVersion: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    let rows: LeaderboardScoreRow[];
    let returnedVersion: string;

    if (args.benchmarkVersion === ALL_BENCHMARK_VERSIONS) {
      const publicBenchmarks = (
        await ctx.db.query("benchmarkVersions").collect()
      ).filter((benchmark) => benchmark.provenance !== "unminted");
      const publicIds = new Set(
        publicBenchmarks.map((benchmark) => benchmark._id),
      );
      const scoreRows = (
        await ctx.db
          .query("modelScores")
          .withIndex("by_experiment", (q) =>
            q.eq("experiment", args.experiment),
          )
          .collect()
      ).filter((row) => publicIds.has(row.benchmarkVersion));

      const byModel = new Map<Id<"models">, Doc<"modelScores">[]>();
      for (const row of scoreRows) {
        const modelRows = byModel.get(row.modelId) ?? [];
        modelRows.push(row);
        byModel.set(row.modelId, modelRows);
      }
      rows = [...byModel.values()].map(combineModelScoreRows);
      returnedVersion = ALL_BENCHMARK_VERSIONS;
    } else {
      const benchmark = args.benchmarkVersion
        ? await ctx.db
            .query("benchmarkVersions")
            .withIndex("by_version", (q) =>
              q.eq("version", args.benchmarkVersion!),
            )
            .unique()
        : await getCurrentBenchmark(ctx);
      if (!benchmark) return [];

      rows = await ctx.db
        .query("modelScores")
        .withIndex("by_experiment_benchmark", (q) =>
          q
            .eq("experiment", args.experiment)
            .eq("benchmarkVersion", benchmark._id),
        )
        .collect();
      returnedVersion = benchmark.version;
    }
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
      benchmarkVersion: returnedVersion,
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

/** Lists the current benchmark and archived score partitions. */
export const leaderboardVersions = query({
  args: {
    experiment: v.optional(experimentLiteral),
  },
  handler: async (ctx, args) => {
    const currentBenchmark = await getCurrentBenchmark(ctx);
    const benchmarks = await ctx.db
      .query("benchmarkVersions")
      .withIndex("by_effectiveAt")
      .order("desc")
      .collect();
    const scoreRows = await ctx.db
      .query("modelScores")
      .withIndex("by_experiment", (q) => q.eq("experiment", args.experiment))
      .collect();
    const models = await ctx.db.query("models").collect();
    const modelSlugs = new Map(models.map((model) => [model._id, model.slug]));
    const publicBenchmarks = benchmarks.filter(
      (benchmark) => benchmark.provenance !== "unminted",
    );

    const versions = publicBenchmarks.map((benchmark) => {
      const rows = scoreRows.filter(
        (row) => row.benchmarkVersion === benchmark._id,
      );
      const scoredSlugs = new Set(
        rows.map((row) => modelSlugs.get(row.modelId)).filter(Boolean),
      );
      const curatedModelsScored = benchmark.curatedModels.filter((model) =>
        scoredSlugs.has(model),
      ).length;
      return {
        version: benchmark.version,
        evalCount: benchmark.evalCount,
        benchmarkCount: 1,
        mintedAt: benchmark.effectiveAt,
        provenance: benchmark.provenance,
        modelCount: rows.length,
        curatedModelCount: benchmark.curatedModels.length,
        curatedModelsScored,
        isCurrent: currentBenchmark?.version === benchmark.version,
        isLegacy: false,
        isAll: false,
      };
    });

    if (publicBenchmarks.length > 0) {
      const publicIds = new Set(
        publicBenchmarks.map((benchmark) => benchmark._id),
      );
      const allRows = scoreRows.filter((row) =>
        publicIds.has(row.benchmarkVersion),
      );
      versions.push({
        version: ALL_BENCHMARK_VERSIONS,
        evalCount: 0,
        benchmarkCount: publicBenchmarks.length,
        mintedAt: 0,
        provenance: "reconstructed",
        modelCount: new Set(allRows.map((row) => row.modelId)).size,
        curatedModelCount: 0,
        curatedModelsScored: 0,
        isCurrent: false,
        isLegacy: false,
        isAll: true,
      });
    }

    return versions;
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
    benchmarkVersion: v.optional(v.string()),
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

    // Query the exact score partition. A wall-clock cutoff would eventually
    // make archived benchmark charts empty even though their score still
    // exists, so keep this bounded by count instead.
    const historyLimit =
      args.limit !== undefined && args.limit > 0
        ? Math.min(args.limit, 100)
        : LEADERBOARD_HISTORY_SIZE;
    let runs: Doc<"runs">[];
    if (args.benchmarkVersion === ALL_BENCHMARK_VERSIONS) {
      const publicBenchmarks = (
        await ctx.db.query("benchmarkVersions").collect()
      ).filter((benchmark) => benchmark.provenance !== "unminted");
      const benchmarkById = new Map(
        publicBenchmarks.map((benchmark) => [benchmark._id, benchmark]),
      );
      runs = await ctx.db
        .query("runs")
        .withIndex("by_modelId", (q) => q.eq("modelId", targetModelId))
        .order("desc")
        .collect();
      runs = runs.filter((run) => {
        const benchmark = benchmarkById.get(run.benchmarkVersion);
        return (
          run.experiment === args.experiment &&
          run.status.kind === "completed" &&
          benchmark !== undefined &&
          hasCompleteBenchmarkPlan(run, benchmark.evalCount)
        );
      });
    } else {
      const benchmark = args.benchmarkVersion
        ? await ctx.db
            .query("benchmarkVersions")
            .withIndex("by_version", (q) =>
              q.eq("version", args.benchmarkVersion!),
            )
            .unique()
        : await getCurrentBenchmark(ctx);
      if (!benchmark) return [];

      runs = await ctx.db
        .query("runs")
        .withIndex("by_modelId_experiment_benchmark", (q) =>
          q
            .eq("modelId", targetModelId)
            .eq("experiment", args.experiment)
            .eq("benchmarkVersion", benchmark._id),
        )
        .filter((q) => q.eq(q.field("status.kind"), "completed"))
        .order("desc")
        .collect();
      runs = runs.filter(
        (run) =>
          run.status.kind === "completed" &&
          hasCompleteBenchmarkPlan(run, benchmark.evalCount),
      );
    }

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

    return results.slice(-historyLimit);
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
