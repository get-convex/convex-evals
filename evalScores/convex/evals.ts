import { internalMutation } from "./_generated/server";
import { v } from "convex/values";

const evalStatus = v.union(
  v.object({ kind: v.literal("pending") }),
  v.object({ kind: v.literal("running") }),
  v.object({ kind: v.literal("passed"), durationMs: v.number(), outputStorageId: v.optional(v.id("_storage")) }),
  v.object({ kind: v.literal("failed"), failureReason: v.string(), durationMs: v.number(), outputStorageId: v.optional(v.id("_storage")) }),
);

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
    const id = await ctx.db.insert("evals", {
      runId: args.runId,
      evalPath: args.evalPath,
      category: args.category,
      name: args.name,
      status: { kind: "pending" },
      task: args.task,
      evalSourceStorageId: args.evalSourceStorageId,
    });
    return id;
  },
});

export const updateEvalStatus = internalMutation({
  args: {
    evalId: v.id("evals"),
    status: evalStatus,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch(args.evalId, {
      status: args.status,
    });
    return null;
  },
});

export const completeEval = internalMutation({
  args: {
    evalId: v.id("evals"),
    status: v.union(
      v.object({ kind: v.literal("passed"), durationMs: v.number(), outputStorageId: v.optional(v.id("_storage")) }),
      v.object({ kind: v.literal("failed"), failureReason: v.string(), durationMs: v.number(), outputStorageId: v.optional(v.id("_storage")) }),
    ),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch(args.evalId, {
      status: args.status,
    });
    return null;
  },
});
