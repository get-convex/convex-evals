import { combineWebUsage, computeWebUsage, webUsageAverages } from "./webUsage";
import { internalMutation, query, type QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { experimentLiteral, languageModelUsage } from "./schema.js";
import { internal } from "./_generated/api.js";
import {
  findBenchmarkByKind,
  listBenchmarksByKind,
  latestBenchmarkByKind,
  type CodingBenchmark,
} from "./benchmarkKinds.js";
import { resolveBenchmarkForRun } from "./benchmarkVersions";
import {
  LEADERBOARD_HISTORY_SIZE,
  computeRunCostUsd,
  computeRunDurationMs,
  hasIncompleteProviderUsage,
  isFullyCompletedRun,
  hasCompleteBenchmarkPlan,
  computeRunScores,
} from "./scoringUtils.js";
import {
  assertNever,
  requireCodingModelScore,
  requireCodingEval,
  requireCodingRun,
  type CodingEval,
  type CodingModelScore,
  type CodingRun,
} from "./documentKinds.js";
import { deleteDecisionRunData } from "./decisionStorage.js";

export {
  decisionLeaderboard,
  listDecisionRuns,
  getDecisionRun,
} from "./decisionViews.js";

const ALL_BENCHMARK_VERSIONS = "all";
const DAY_MS = 24 * 60 * 60 * 1000;
const PREVIOUS_BENCHMARK_MAX_AGE_MS = 183 * DAY_MS;
const MAX_LEADERBOARD_ROWS = 100;

type ScoreSummary = {
  mean: number;
  stdDev: number;
  count: number;
};

type LeaderboardScoreRow = Pick<
  CodingModelScore,
  | "webUsage"
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

const leaderboardScoreValidator = v.object({
  modelId: v.id("models"),
  model: v.string(),
  formattedName: v.string(),
  openRouterFirstSeenAt: v.number(),
  benchmarkVersion: v.string(),
  scoreBenchmarkVersion: v.string(),
  scoreBenchmarkEvalCount: v.number(),
  scoreBenchmarkMintedAt: v.number(),
  matchesSelectedBenchmark: v.boolean(),
  totalScore: v.number(),
  totalScoreErrorBar: v.number(),
  averageRunDurationMs: v.number(),
  averageRunDurationMsErrorBar: v.number(),
  averageRunCostUsd: v.union(v.number(), v.null()),
  averageRunCostUsdErrorBar: v.union(v.number(), v.null()),
  averageWebSearchesPerEval: v.union(v.number(), v.null()),
  averageWebSearchesEstimated: v.boolean(),
  averageWebFetchesPerEval: v.union(v.number(), v.null()),
  webSearchTelemetryEvalCount: v.number(),
  webUsageEvalCount: v.number(),
  scores: v.record(v.string(), v.number()),
  scoreErrorBars: v.record(v.string(), v.number()),
  runCount: v.number(),
  latestRunId: v.id("runs"),
  latestRunTime: v.number(),
});

type ScoreBenchmarkMetadata = {
  version: string;
  evalCount: number;
  mintedAt: number;
  matchesSelectedBenchmark: boolean;
};

function clampLeaderboardLimit(limit: number | undefined): number {
  if (limit === undefined) return MAX_LEADERBOARD_ROWS;
  return Math.max(1, Math.min(MAX_LEADERBOARD_ROWS, Math.floor(limit)));
}

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

function combineModelScoreRows(rows: CodingModelScore[]): LeaderboardScoreRow {
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
    rows.flatMap((row) =>
      row.averageRunDurationMs <= 0
        ? []
        : [
            {
              mean: row.averageRunDurationMs,
              stdDev: row.averageRunDurationMsErrorBar,
              count: row.runCount,
            },
          ],
    ),
  );
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
    webUsage: combineWebUsage(rows.map((row) => row.webUsage)),
    modelId: latest.modelId,
    totalScore: totalScore.mean,
    totalScoreErrorBar: totalScore.stdDev,
    averageRunDurationMs: duration?.mean ?? 0,
    averageRunDurationMsErrorBar: duration?.stdDev ?? 0,
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
): Promise<CodingBenchmark | null> {
  return await latestBenchmarkByKind(ctx, "coding");
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
      kind: "coding",
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
    const storedRun = await ctx.db.get("runs", args.runId);
    if (!storedRun) return null;
    const run = requireCodingRun(storedRun);
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
    const storedRun = await ctx.db.get("runs", args.runId);
    if (!storedRun) return null;
    const run = storedRun;
    switch (run.kind) {
      case "decision":
        await deleteDecisionRunData(ctx, run);
        await ctx.db.delete("runs", run._id);
        return null;
      case "coding":
        break;
      default:
        return assertNever(run);
    }
    const benchmarkVersion = run.benchmarkVersion;

    // Collect all evals for this run
    const storedEvals = await ctx.db
      .query("evals")
      .withIndex("by_kind_runId", (q) =>
        q.eq("kind", "coding").eq("runId", args.runId),
      )
      .collect();
    const wrongKindEval = await ctx.db
      .query("evals")
      .withIndex("by_kind_runId", (q) =>
        q.eq("kind", "decision").eq("runId", args.runId),
      )
      .first();
    if (wrongKindEval) {
      throw new Error(
        `Coding run ${run._id} has decision result ${wrongKindEval._id}`,
      );
    }
    const evals: CodingEval[] = [];
    for (const evalDoc of storedEvals) {
      switch (evalDoc.kind) {
        case "coding":
          evals.push(evalDoc);
          break;
        case "decision":
          throw new Error(
            `Coding run ${run._id} has decision result ${evalDoc._id}`,
          );
        default:
          assertNever(evalDoc);
      }
    }

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
    const storedRun = await ctx.db.get("runs", args.runId);
    if (!storedRun) return null;
    const run = requireCodingRun(storedRun);
    const model = run.modelId ? await ctx.db.get("models", run.modelId) : null;

    const evals = await ctx.db
      .query("evals")
      .withIndex("by_kind_runId", (q) =>
        q.eq("kind", "coding").eq("runId", args.runId),
      )
      .collect()
      .then((rows) => rows.map(requireCodingEval));

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
    let runsQuery = ctx.db
      .query("runs")
      .withIndex("by_kind", (q) => q.eq("kind", "coding"))
      .order("desc");

    // Apply filters if provided
    if (args.experiment) {
      runsQuery = ctx.db
        .query("runs")
        .withIndex("by_kind_experiment", (q) =>
          q.eq("kind", "coding").eq("experiment", args.experiment),
        )
        .order("desc");
    } else if (args.modelId) {
      const modelId = args.modelId;
      runsQuery = ctx.db
        .query("runs")
        .withIndex("by_kind_modelId", (q) =>
          q.eq("kind", "coding").eq("modelId", modelId),
        )
        .order("desc");
    }

    // This query also loads eval documents per returned run to compute counts.
    // Cap the run count to keep total bytes read below Convex function limits.
    const MAX_LIST_RUNS_LIMIT = 40;
    const requestedLimit = args.limit ?? 100;
    const limit = Math.min(Math.max(requestedLimit, 1), MAX_LIST_RUNS_LIMIT);
    const runs = (await runsQuery.take(limit)).map(requireCodingRun);

    // Fetch eval counts for each run
    const models = await ctx.db.query("models").collect();
    const modelMap = new Map(models.map((m) => [m._id, m] as const));
    const runsWithCounts = await Promise.all(
      runs.map(async (run) => {
        const evals = await ctx.db
          .query("evals")
          .withIndex("by_kind_runId", (q) =>
            q.eq("kind", "coding").eq("runId", run._id),
          )
          .collect()
          .then((rows) => rows.map(requireCodingEval));

        const passedCount = evals.filter(
          (e) => e.status.kind === "passed",
        ).length;
        const failedCount = evals.filter(
          (e) => e.status.kind === "failed",
        ).length;
        const totalCount = evals.length;

        const model = modelMap.get(run.modelId);
        const { kind: _kind, ...publicRun } = run;
        return {
          ...publicRun,
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
    includeRecentPreviousBenchmarks: v.optional(v.boolean()),
    limit: v.optional(v.number()),
    modelId: v.optional(v.id("models")),
    model: v.optional(v.string()),
  },
  returns: v.array(leaderboardScoreValidator),
  handler: async (ctx, args) => {
    const modelBySlug = args.model
      ? await ctx.db
          .query("models")
          .withIndex("by_slug", (q) => q.eq("slug", args.model!))
          .unique()
      : null;
    if (args.model && !modelBySlug) return [];
    if (args.modelId && modelBySlug && args.modelId !== modelBySlug._id) {
      return [];
    }
    const targetModelId = args.modelId ?? modelBySlug?._id;
    let rows: LeaderboardScoreRow[];
    let returnedVersion: string;
    const scoreBenchmarkByModel = new Map<
      Id<"models">,
      ScoreBenchmarkMetadata
    >();

    if (args.benchmarkVersion === ALL_BENCHMARK_VERSIONS) {
      const publicBenchmarks = (
        await listBenchmarksByKind(ctx, "coding")
      ).filter((benchmark) => benchmark.provenance !== "unminted");
      const publicIds = new Set(
        publicBenchmarks.map((benchmark) => benchmark._id),
      );
      // This aggregate must include every public partition. A fixed take()
      // would silently change historical scores once the table grows past it.
      const storedScoreRows = targetModelId
        ? await ctx.db
            .query("modelScores")
            .withIndex("by_kind_modelId_experiment_benchmark", (q) =>
              q
                .eq("kind", "coding")
                .eq("modelId", targetModelId)
                .eq("experiment", args.experiment),
            )
            .collect()
        : await ctx.db
            .query("modelScores")
            .withIndex("by_kind_experiment", (q) =>
              q.eq("kind", "coding").eq("experiment", args.experiment),
            )
            .collect();
      const scoreRows = storedScoreRows
        .map(requireCodingModelScore)
        .filter((row): row is CodingModelScore => row.kind === "coding")
        .filter((row) => publicIds.has(row.benchmarkVersion));

      const byModel = new Map<Id<"models">, CodingModelScore[]>();
      for (const row of scoreRows) {
        const modelRows = byModel.get(row.modelId) ?? [];
        modelRows.push(row);
        byModel.set(row.modelId, modelRows);
      }
      rows = [...byModel.values()].map(combineModelScoreRows);
      returnedVersion = ALL_BENCHMARK_VERSIONS;
      for (const row of rows) {
        scoreBenchmarkByModel.set(row.modelId, {
          version: ALL_BENCHMARK_VERSIONS,
          evalCount: 0,
          mintedAt: 0,
          matchesSelectedBenchmark: true,
        });
      }
    } else {
      const benchmark = args.benchmarkVersion
        ? await findBenchmarkByKind(ctx, "coding", args.benchmarkVersion)
        : await getCurrentBenchmark(ctx);
      if (!benchmark) return [];

      const storedScoreRows = targetModelId
        ? await ctx.db
            .query("modelScores")
            .withIndex("by_kind_modelId_experiment_benchmark", (q) =>
              q
                .eq("kind", "coding")
                .eq("modelId", targetModelId)
                .eq("experiment", args.experiment)
                .eq("benchmarkVersion", benchmark._id),
            )
            .collect()
        : await ctx.db
            .query("modelScores")
            .withIndex("by_kind_experiment_benchmark", (q) =>
              q
                .eq("kind", "coding")
                .eq("experiment", args.experiment)
                .eq("benchmarkVersion", benchmark._id),
            )
            .collect();
      rows = storedScoreRows
        .map(requireCodingModelScore)
        .filter((row): row is CodingModelScore => row.kind === "coding");
      returnedVersion = benchmark.version;
      for (const row of rows) {
        scoreBenchmarkByModel.set(row.modelId, {
          version: benchmark.version,
          evalCount: benchmark.evalCount,
          mintedAt: benchmark.effectiveAt,
          matchesSelectedBenchmark: true,
        });
      }

      const currentBenchmark = args.includeRecentPreviousBenchmarks
        ? args.benchmarkVersion
          ? await getCurrentBenchmark(ctx)
          : benchmark
        : null;
      const isCurrentSelection = currentBenchmark?._id === benchmark._id;
      if (args.includeRecentPreviousBenchmarks && isCurrentSelection) {
        const publicBenchmarks = (
          await listBenchmarksByKind(ctx, "coding")
        ).filter((candidate) => candidate.provenance !== "unminted");
        const publicBenchmarkById = new Map(
          publicBenchmarks.map((candidate) => [candidate._id, candidate]),
        );
        const cutoff = Date.now() - PREVIOUS_BENCHMARK_MAX_AGE_MS;
        // modelScores rows are patched in place, so document creation order is
        // not score recency. Read the complete experiment before comparing
        // latestRunTime or a recently updated fallback could be omitted.
        const storedPreviousRows = targetModelId
          ? await ctx.db
              .query("modelScores")
              .withIndex("by_kind_modelId_experiment_benchmark", (q) =>
                q
                  .eq("kind", "coding")
                  .eq("modelId", targetModelId)
                  .eq("experiment", args.experiment),
              )
              .collect()
          : await ctx.db
              .query("modelScores")
              .withIndex("by_kind_experiment", (q) =>
                q.eq("kind", "coding").eq("experiment", args.experiment),
              )
              .collect();
        const previousRows = storedPreviousRows
          .map(requireCodingModelScore)
          .filter((row): row is CodingModelScore => row.kind === "coding");
        const latestPreviousByModel = new Map<Id<"models">, CodingModelScore>();

        for (const row of previousRows) {
          if (
            row.benchmarkVersion === benchmark._id ||
            row.latestRunTime < cutoff ||
            !publicBenchmarkById.has(row.benchmarkVersion) ||
            scoreBenchmarkByModel.has(row.modelId)
          ) {
            continue;
          }
          const existing = latestPreviousByModel.get(row.modelId);
          if (!existing || row.latestRunTime > existing.latestRunTime) {
            latestPreviousByModel.set(row.modelId, row);
          }
        }

        for (const row of latestPreviousByModel.values()) {
          const scoreBenchmark = publicBenchmarkById.get(row.benchmarkVersion)!;
          rows.push(row);
          scoreBenchmarkByModel.set(row.modelId, {
            version: scoreBenchmark.version,
            evalCount: scoreBenchmark.evalCount,
            mintedAt: scoreBenchmark.effectiveAt,
            matchesSelectedBenchmark: false,
          });
        }
      }
    }
    // Only load metadata for models represented in the candidate score rows.
    // This avoids scanning the whole models table as discovery adds models.
    const modelIds = [...new Set(rows.map((row) => row.modelId))];
    const modelEntries = await Promise.all(
      modelIds.map(
        async (modelId) =>
          [
            modelId,
            modelBySlug?._id === modelId
              ? modelBySlug
              : await ctx.db.get(modelId),
          ] as const,
      ),
    );
    const modelMap = new Map(modelEntries);

    // Keep the selected benchmark's real ranking intact. Previous-benchmark
    // rows follow it in recency order and are only context, never rank entries.
    rows.sort((a, b) => {
      const modelA = modelMap.get(a.modelId)?.slug ?? "";
      const modelB = modelMap.get(b.modelId)?.slug ?? "";
      const metadataA = scoreBenchmarkByModel.get(a.modelId)!;
      const metadataB = scoreBenchmarkByModel.get(b.modelId)!;
      if (
        metadataA.matchesSelectedBenchmark !==
        metadataB.matchesSelectedBenchmark
      ) {
        return metadataA.matchesSelectedBenchmark ? -1 : 1;
      }
      if (!metadataA.matchesSelectedBenchmark) {
        return (
          b.latestRunTime - a.latestRunTime || modelA.localeCompare(modelB)
        );
      }
      return b.totalScore - a.totalScore || modelA.localeCompare(modelB);
    });

    const limit = args.includeRecentPreviousBenchmarks
      ? clampLeaderboardLimit(args.limit)
      : args.limit === undefined
        ? rows.length
        : clampLeaderboardLimit(args.limit);

    return rows.slice(0, limit).map((r) => ({
      modelId: r.modelId,
      model: modelMap.get(r.modelId)?.slug ?? "unknown-model",
      formattedName: modelMap.get(r.modelId)?.formattedName ?? "Unknown model",
      openRouterFirstSeenAt:
        modelMap.get(r.modelId)?.openRouterFirstSeenAt ?? 0,
      benchmarkVersion: returnedVersion,
      scoreBenchmarkVersion: scoreBenchmarkByModel.get(r.modelId)!.version,
      scoreBenchmarkEvalCount: scoreBenchmarkByModel.get(r.modelId)!.evalCount,
      scoreBenchmarkMintedAt: scoreBenchmarkByModel.get(r.modelId)!.mintedAt,
      matchesSelectedBenchmark: scoreBenchmarkByModel.get(r.modelId)!
        .matchesSelectedBenchmark,
      totalScore: r.totalScore,
      totalScoreErrorBar: r.totalScoreErrorBar,
      averageRunDurationMs: r.averageRunDurationMs,
      averageRunDurationMsErrorBar: r.averageRunDurationMsErrorBar,
      ...webUsageAverages(r.webUsage),
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
    const benchmarks = await listBenchmarksByKind(ctx, "coding");
    const scoreRows = await ctx.db
      .query("modelScores")
      .withIndex("by_kind_experiment", (q) =>
        q.eq("kind", "coding").eq("experiment", args.experiment),
      )
      .collect()
      .then((rows) =>
        rows
          .map(requireCodingModelScore)
          .filter((row): row is CodingModelScore => row.kind === "coding"),
      );
    // Versions need metadata only for models that have a score in this
    // experiment. Unrelated registered models do not affect the selector.
    const modelIds = [...new Set(scoreRows.map((row) => row.modelId))];
    const models = await Promise.all(modelIds.map((id) => ctx.db.get(id)));
    const modelSlugs = new Map(
      models.flatMap((model) =>
        model ? [[model._id, model.slug] as const] : [],
      ),
    );
    const currentBenchmark = benchmarks.find(
      (benchmark) => benchmark.provenance !== "unminted",
    );
    const scoresByBenchmark = new Map<
      Id<"benchmarkVersions">,
      CodingModelScore[]
    >();
    for (const row of scoreRows) {
      const rows = scoresByBenchmark.get(row.benchmarkVersion) ?? [];
      rows.push(row);
      scoresByBenchmark.set(row.benchmarkVersion, rows);
    }
    // A reconstructed partition can become empty after its runs are proven to
    // belong to a later full-content benchmark. Do not leave an empty duplicate
    // in the public selector just because its provenance record remains.
    const scoredBenchmarkIds = new Set(
      scoreRows.map((row) => row.benchmarkVersion),
    );
    const publicBenchmarks = benchmarks.filter(
      (benchmark) =>
        benchmark.provenance !== "unminted" &&
        (benchmark.provenance !== "reconstructed" ||
          scoredBenchmarkIds.has(benchmark._id)),
    );

    const versions = publicBenchmarks.map((benchmark) => {
      const rows = scoresByBenchmark.get(benchmark._id) ?? [];
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
      runCostUsd: v.union(v.number(), v.null()),
      averageGenerationTimeMs: v.union(v.number(), v.null()),
      averageWebSearchesPerEval: v.union(v.number(), v.null()),
      averageWebSearchesEstimated: v.boolean(),
      webSearchTelemetryEvalCount: v.number(),
      webUsageEvalCount: v.number(),
      evalCount: v.number(),
      passedEvalCount: v.number(),
      failedEvalCount: v.number(),
      inputTokens: v.union(v.number(), v.null()),
      outputTokens: v.union(v.number(), v.null()),
      reasoningTokens: v.union(v.number(), v.null()),
      failures: v.array(
        v.object({
          evalId: v.id("evals"),
          evalPath: v.string(),
          category: v.string(),
          name: v.string(),
          failureReason: v.string(),
        }),
      ),
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
    let candidateRuns: AsyncIterable<Doc<"runs">>;
    let benchmarkById: Map<Id<"benchmarkVersions">, CodingBenchmark>;
    if (args.benchmarkVersion === ALL_BENCHMARK_VERSIONS) {
      const publicBenchmarks = (
        await listBenchmarksByKind(ctx, "coding")
      ).filter((benchmark) => benchmark.provenance !== "unminted");
      benchmarkById = new Map(
        publicBenchmarks.map((benchmark) => [benchmark._id, benchmark]),
      );
      // This index preserves creation order across benchmark versions.
      candidateRuns = ctx.db
        .query("runs")
        .withIndex("by_kind_modelId", (q) =>
          q.eq("kind", "coding").eq("modelId", targetModelId),
        )
        .filter((q) =>
          q.and(
            q.eq(q.field("experiment"), args.experiment),
            q.eq(q.field("status.kind"), "completed"),
          ),
        )
        .order("desc");
    } else {
      const benchmark = args.benchmarkVersion
        ? await findBenchmarkByKind(ctx, "coding", args.benchmarkVersion)
        : await getCurrentBenchmark(ctx);
      if (!benchmark) return [];
      benchmarkById = new Map([[benchmark._id, benchmark]]);
      candidateRuns = ctx.db
        .query("runs")
        .withIndex("by_kind_modelId_experiment_benchmark", (q) =>
          q
            .eq("kind", "coding")
            .eq("modelId", targetModelId)
            .eq("experiment", args.experiment)
            .eq("benchmarkVersion", benchmark._id),
        )
        .filter((q) => q.and(q.eq(q.field("status.kind"), "completed")))
        .order("desc");
    }

    // Fetch evals and filter to only fully-completed runs, computing scores
    type HistoryResult = {
      _creationTime: number;
      runId: Id<"runs">;
      totalScore: number;
      scores: Record<string, number>;
      runCostUsd: number | null;
      averageGenerationTimeMs: number | null;
      averageWebSearchesPerEval: number | null;
      averageWebSearchesEstimated: boolean;
      webSearchTelemetryEvalCount: number;
      webUsageEvalCount: number;
      evalCount: number;
      passedEvalCount: number;
      failedEvalCount: number;
      inputTokens: number | null;
      outputTokens: number | null;
      reasoningTokens: number | null;
      failures: Array<{
        evalId: Id<"evals">;
        evalPath: string;
        category: string;
        name: string;
        failureReason: string;
      }>;
    };
    const results: HistoryResult[] = [];
    // Stop only after enough valid runs. Taking candidates first would let
    // recent partial runs hide older complete runs; collecting first would
    // read every historical run and its evals on each model-page request.
    for await (const storedRun of candidateRuns) {
      const run = requireCodingRun(storedRun);
      const benchmark = benchmarkById.get(run.benchmarkVersion);
      if (!benchmark || !hasCompleteBenchmarkPlan(run, benchmark.evalCount))
        continue;
      const evals = await ctx.db
        .query("evals")
        .withIndex("by_kind_runId", (q) =>
          q.eq("kind", "coding").eq("runId", run._id),
        )
        .collect()
        .then((rows) => rows.map(requireCodingEval));
      if (!isFullyCompletedRun(run, evals)) continue;
      const { totalScore, scores } = computeRunScores(evals);
      const webUsage =
        run.experiment === "no_guidelines_with_web"
          ? webUsageAverages(computeWebUsage(evals))
          : webUsageAverages(undefined);
      const terminalEvals = evals.filter(
        (evalDoc) =>
          evalDoc.status.kind === "passed" || evalDoc.status.kind === "failed",
      );
      let inputTokens = 0;
      let outputTokens = 0;
      let reasoningTokens = 0;
      let hasCompleteInputTokens = terminalEvals.length > 0;
      let hasCompleteOutputTokens = terminalEvals.length > 0;
      let hasCompleteReasoningTokens = terminalEvals.length > 0;
      let providerUsageIsComplete = true;
      for (const evalDoc of terminalEvals) {
        if (
          evalDoc.status.kind !== "passed" &&
          evalDoc.status.kind !== "failed"
        ) {
          continue;
        }
        const usage = evalDoc.status.usage;
        if (hasIncompleteProviderUsage(evalDoc)) {
          providerUsageIsComplete = false;
        }
        if (typeof usage?.inputTokens === "number") {
          inputTokens += usage.inputTokens;
        } else {
          hasCompleteInputTokens = false;
        }
        if (typeof usage?.outputTokens === "number") {
          outputTokens += usage.outputTokens;
        } else {
          hasCompleteOutputTokens = false;
        }
        const evalReasoningTokens =
          usage?.outputTokenDetails?.reasoningTokens ?? usage?.reasoningTokens;
        if (typeof evalReasoningTokens === "number") {
          reasoningTokens += evalReasoningTokens;
        } else {
          hasCompleteReasoningTokens = false;
        }
      }
      const failedEvals = terminalEvals.filter(
        (evalDoc) => evalDoc.status.kind === "failed",
      );
      results.push({
        _creationTime: run._creationTime,
        runId: run._id,
        totalScore,
        scores,
        runCostUsd: computeRunCostUsd(evals),
        averageGenerationTimeMs: computeRunDurationMs(evals),
        averageWebSearchesPerEval: webUsage.averageWebSearchesPerEval,
        averageWebSearchesEstimated: webUsage.averageWebSearchesEstimated,
        webSearchTelemetryEvalCount: webUsage.webSearchTelemetryEvalCount,
        webUsageEvalCount: webUsage.webUsageEvalCount,
        evalCount: terminalEvals.length,
        passedEvalCount: terminalEvals.length - failedEvals.length,
        failedEvalCount: failedEvals.length,
        inputTokens:
          providerUsageIsComplete && hasCompleteInputTokens
            ? inputTokens
            : null,
        outputTokens:
          providerUsageIsComplete && hasCompleteOutputTokens
            ? outputTokens
            : null,
        reasoningTokens:
          providerUsageIsComplete && hasCompleteReasoningTokens
            ? reasoningTokens
            : null,
        failures: failedEvals.slice(0, 8).map((evalDoc) => ({
          evalId: evalDoc._id,
          evalPath: evalDoc.evalPath,
          category: evalDoc.category,
          name: evalDoc.name,
          failureReason:
            evalDoc.status.kind === "failed"
              ? evalDoc.status.failureReason
              : "Unknown failure",
        })),
      });
      if (results.length >= historyLimit) break;
    }

    // Candidates were read newest first; charts display oldest first.
    return results.reverse();
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
      .withIndex("by_kind_modelId", (q) =>
        q.eq("kind", "coding").eq("modelId", args.modelId),
      )
      .order("desc")
      .take(MODEL_SUMMARY_RUNS_PER_MODEL)
      .then((rows) => rows.map(requireCodingRun));

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
        .withIndex("by_kind_runId", (q) =>
          q.eq("kind", "coding").eq("runId", run._id),
        )
        .collect()
        .then((rows) => rows.map(requireCodingEval));

      const scorable = evals.filter(
        (e) => e.status.kind === "passed" || e.status.kind === "failed",
      );
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
      .withIndex("by_kind_modelId", (q) =>
        q.eq("kind", "coding").eq("modelId", args.modelId),
      )
      .order("desc")
      .first();

    return latestRun?._creationTime ?? null;
  },
});
