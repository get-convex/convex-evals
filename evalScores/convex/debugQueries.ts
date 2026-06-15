/**
 * Internal queries used by the debug action.
 * Separated into their own module to avoid circular type inference.
 */
import { internalQuery } from "./_generated/server";
import { v } from "convex/values";

export const getEvalRecord = internalQuery({
  args: { evalId: v.id("evals") },
  handler: async (ctx, args) => {
    return await ctx.db.get("evals", args.evalId);
  },
});

export const getStepsForEval = internalQuery({
  args: { evalId: v.id("evals") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("steps")
      .withIndex("by_evalId", (q) => q.eq("evalId", args.evalId))
      .collect();
  },
});

export const getRunRecord = internalQuery({
  args: { runId: v.id("runs") },
  handler: async (ctx, args) => {
    return await ctx.db.get("runs", args.runId);
  },
});

export const getModelRecord = internalQuery({
  args: { modelId: v.id("models") },
  handler: async (ctx, args) => {
    return await ctx.db.get("models", args.modelId);
  },
});

/**
 * Get a lightweight summary of all failed evals for a run.
 * Returns the eval IDs, names, categories, and failure reasons
 * without unzipping any output files.
 */
export const getFailedEvalsForRun = internalQuery({
  args: { runId: v.id("runs") },
  handler: async (ctx, args) => {
    const run = await ctx.db.get("runs", args.runId);
    if (!run) return null;

    const evals = await ctx.db
      .query("evals")
      .withIndex("by_runId", (q) => q.eq("runId", args.runId))
      .collect();

    const failed = evals.filter((e) => e.status.kind === "failed");

    const failedWithSteps = await Promise.all(
      failed.map(async (evalDoc) => {
        const steps = await ctx.db
          .query("steps")
          .withIndex("by_evalId", (q) => q.eq("evalId", evalDoc._id))
          .collect();

        // Find which step actually failed
        const failedStep = steps.find((s) => s.status.kind === "failed");

        return {
          _id: evalDoc._id,
          evalPath: evalDoc.evalPath,
          category: evalDoc.category,
          name: evalDoc.name,
          failureReason:
            evalDoc.status.kind === "failed"
              ? evalDoc.status.failureReason
              : "unknown",
          failedStep: failedStep
            ? {
                name: failedStep.name,
                failureReason:
                  failedStep.status.kind === "failed"
                    ? failedStep.status.failureReason
                    : "unknown",
              }
            : null,
        };
      }),
    );
    const modelDoc = run.modelId ? await ctx.db.get("models", run.modelId) : null;

    return {
      run: {
        _id: run._id,
        model: modelDoc && "slug" in modelDoc ? modelDoc.slug : "unknown-model",
        provider: run.provider ?? null,
        experiment: run.experiment ?? "default",
        status: run.status,
      },
      totalEvals: evals.length,
      passedCount: evals.filter((e) => e.status.kind === "passed").length,
      failedCount: failed.length,
      failedEvals: failedWithSteps,
    };
  },
});
