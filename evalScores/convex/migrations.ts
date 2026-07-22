import { Migrations } from "@convex-dev/migrations";
import { components, internal } from "./_generated/api.js";
import { internalQuery } from "./_generated/server";
import type { DataModel, Id } from "./_generated/dataModel.js";
import { historicalBenchmarkForRun } from "./historicalBenchmarks";

export const migrations = new Migrations<DataModel>(components.migrations);

/**
 * Historical eval rows recorded scorer duration but not model generation
 * duration. startEval creates the eval document immediately before model
 * generation, and the first scoring step is recorded immediately after
 * generation, so this backfills a generation latency estimate.
 */
export const backfillEvalGenerationDurations = migrations.define({
  table: "evals",
  batchSize: 25,
  migrateOne: async (ctx, evalDoc) => {
    const status = evalDoc.status;
    if (status.kind !== "passed" && status.kind !== "failed") return;
    if (status.generationDurationMs !== undefined) return;

    const steps = await ctx.db
      .query("steps")
      .withIndex("by_evalId", (q) => q.eq("evalId", evalDoc._id))
      .collect();
    const firstStep = steps.sort(
      (a, b) => a._creationTime - b._creationTime,
    )[0];
    if (!firstStep) return;

    const generationDurationMs =
      firstStep._creationTime - evalDoc._creationTime;
    if (!Number.isFinite(generationDurationMs) || generationDurationMs <= 0) {
      return;
    }

    return {
      status: {
        ...status,
        generationDurationMs,
      },
    };
  },
});

export const runEvalGenerationDurationBackfill = migrations.runner(
  internal.migrations.backfillEvalGenerationDurations,
);

/**
 * Replace missing or old string benchmark references with real IDs. Run
 * benchmarkVersions:seedHistorical first so every reconstructed cohort and
 * the unminted sentinel exist before this migration starts.
 */
export const backfillRunBenchmarkVersionIds = migrations.define({
  table: "runs",
  batchSize: 25,
  migrateOne: async (ctx, runDoc) => {
    if (runDoc.benchmarkVersion !== undefined) {
      const existingId = ctx.db.normalizeId(
        "benchmarkVersions",
        String(runDoc.benchmarkVersion),
      );
      if (existingId && (await ctx.db.get(existingId))) return;

      const byVersion = await ctx.db
        .query("benchmarkVersions")
        .withIndex("by_version", (q) =>
          q.eq("version", String(runDoc.benchmarkVersion)),
        )
        .unique();
      if (byVersion) return { benchmarkVersion: byVersion._id };
    }

    const definition = await historicalBenchmarkForRun(
      runDoc.plannedEvals,
      runDoc._creationTime,
    );
    const reconstructed = await ctx.db
      .query("benchmarkVersions")
      .withIndex("by_version", (q) => q.eq("version", definition.version))
      .unique();
    if (!reconstructed) {
      throw new Error(
        `Missing seeded benchmark version ${definition.version}. Run benchmarkVersions:seedHistorical first.`,
      );
    }
    return { benchmarkVersion: reconstructed._id };
  },
});

export const runBenchmarkVersionBackfill = migrations.runner(
  internal.migrations.backfillRunBenchmarkVersionIds,
);

export const auditBenchmarkVersionBackfill = internalQuery({
  args: {},
  handler: async (ctx) => {
    const runs = await ctx.db.query("runs").collect();
    const counts = new Map<Id<"benchmarkVersions">, number>();
    let unresolved = 0;

    for (const run of runs) {
      if (run.benchmarkVersion === undefined) {
        unresolved += 1;
        continue;
      }
      const id = ctx.db.normalizeId(
        "benchmarkVersions",
        String(run.benchmarkVersion),
      );
      if (!id || !(await ctx.db.get(id))) {
        unresolved += 1;
        continue;
      }
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }

    const versions = await ctx.db.query("benchmarkVersions").collect();
    return {
      totalRuns: runs.length,
      unresolved,
      versions: versions
        .map((version) => ({
          version: version.version,
          provenance: version.provenance,
          evalCount: version.evalCount,
          runCount: counts.get(version._id) ?? 0,
        }))
        .sort((a, b) => a.evalCount - b.evalCount),
    };
  },
});

export const run = migrations.runner();

export const runAll = migrations.runner([
  internal.migrations.backfillRunBenchmarkVersionIds,
  internal.migrations.backfillEvalGenerationDurations,
]);
