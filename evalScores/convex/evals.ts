import { internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { languageModelUsage } from "./schema.js";
import { requireCodingEval, requireCodingRun } from "./documentKinds.js";

export { decisionResults } from "./decisionViews.js";

export const createEval = internalMutation({
  args: {
    runId: v.id("runs"),
    evalPath: v.string(),
    category: v.string(),
    name: v.string(),
    task: v.optional(v.string()),
    evalSourceStorageId: v.optional(v.id("_storage")),
  },
  returns: v.id("evals"),
  handler: async (ctx, args) => {
    const storedRun = await ctx.db.get("runs", args.runId);
    if (!storedRun) throw new Error(`Run ${args.runId} not found`);
    const run = requireCodingRun(storedRun);

    const id = await ctx.db.insert("evals", {
      kind: "coding",
      runId: args.runId,
      evalPath: args.evalPath,
      category: args.category,
      name: args.name,
      status: { kind: "pending" },
      task: args.task,
      evalSourceStorageId: args.evalSourceStorageId,
    });

    // Update experiment total evals count
    const expName = run.experiment ?? "default";
    const experiment = await ctx.db
      .query("experiments")
      .withIndex("by_name", (q) => q.eq("name", expName))
      .unique();

    if (experiment) {
      await ctx.db.patch("experiments", experiment._id, {
        totalEvals: experiment.totalEvals + 1,
      });
    }

    return id;
  },
});

export const updateEvalOutput = internalMutation({
  args: {
    evalId: v.id("evals"),
    outputStorageId: v.id("_storage"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const evalDoc = await ctx.db.get("evals", args.evalId);
    if (!evalDoc) return null;
    const codingEval = requireCodingEval(evalDoc);
    const storedRun = await ctx.db.get("runs", codingEval.runId);
    if (!storedRun) throw new Error(`Run ${codingEval.runId} not found`);
    requireCodingRun(storedRun);

    // Only update if the eval is still running
    if (codingEval.status.kind === "running") {
      await ctx.db.patch("evals", args.evalId, {
        status: { ...codingEval.status, outputStorageId: args.outputStorageId },
      });
    }
    return null;
  },
});

export const completeEval = internalMutation({
  args: {
    evalId: v.id("evals"),
    status: v.union(
      v.object({
        kind: v.literal("passed"),
        durationMs: v.number(),
        generationDurationMs: v.optional(v.number()),
        outputStorageId: v.optional(v.id("_storage")),
        usage: v.optional(languageModelUsage),
      }),
      v.object({
        kind: v.literal("failed"),
        failureReason: v.string(),
        durationMs: v.number(),
        generationDurationMs: v.optional(v.number()),
        outputStorageId: v.optional(v.id("_storage")),
        usage: v.optional(languageModelUsage),
      }),
    ),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const evalDoc = await ctx.db.get("evals", args.evalId);
    if (!evalDoc) return null;
    const codingEval = requireCodingEval(evalDoc);
    const storedRun = await ctx.db.get("runs", codingEval.runId);
    if (!storedRun) throw new Error(`Run ${codingEval.runId} not found`);
    const run = requireCodingRun(storedRun);

    await ctx.db.patch("evals", args.evalId, {
      status: args.status,
    });

    // Update experiment passed evals count if this eval passed
    if (args.status.kind === "passed") {
      const expName = run.experiment ?? "default";
      const experiment = await ctx.db
        .query("experiments")
        .withIndex("by_name", (q) => q.eq("name", expName))
        .unique();

      if (experiment) {
        await ctx.db.patch("experiments", experiment._id, {
          passedEvals: experiment.passedEvals + 1,
        });
      }
    }

    return null;
  },
});
