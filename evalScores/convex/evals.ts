import { internalMutation } from "./_generated/server";
import { v } from "convex/values";

const evalStatus = v.union(
  v.object({ kind: v.literal("pending") }),
  v.object({ kind: v.literal("running") }),
  v.object({ kind: v.literal("passed"), durationMs: v.number() }),
  v.object({ kind: v.literal("failed"), failureReason: v.string(), durationMs: v.number() }),
);

export const createEval = internalMutation({
  args: {
    runId: v.id("runs"),
    evalPath: v.string(),
    category: v.string(),
    name: v.string(),
  },
  returns: v.id("evals"),
  handler: async (ctx, args) => {
    const id = await ctx.db.insert("evals", {
      runId: args.runId,
      evalPath: args.evalPath,
      category: args.category,
      name: args.name,
      status: { kind: "pending" },
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
      v.object({ kind: v.literal("passed"), durationMs: v.number() }),
      v.object({ kind: v.literal("failed"), failureReason: v.string(), durationMs: v.number() }),
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
