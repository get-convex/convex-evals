import { Migrations } from "@convex-dev/migrations";
import { components, internal } from "./_generated/api.js";
import type { DataModel } from "./_generated/dataModel.js";

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
    const firstStep = steps.sort((a, b) => a._creationTime - b._creationTime)[0];
    if (!firstStep) return;

    const generationDurationMs = firstStep._creationTime - evalDoc._creationTime;
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

export const run = migrations.runner();

export const runAll = migrations.runner([
  internal.migrations.backfillEvalGenerationDurations,
]);
