import { internalMutation } from "./_generated/server";
import { v } from "convex/values";

const stepNameLiteral = v.union(
  v.literal("filesystem"),
  v.literal("install"),
  v.literal("deploy"),
  v.literal("tsc"),
  v.literal("eslint"),
  v.literal("tests"),
);

const stepStatus = v.union(
  v.object({ kind: v.literal("running") }),
  v.object({ kind: v.literal("passed"), durationMs: v.number() }),
  v.object({ kind: v.literal("failed"), failureReason: v.string(), durationMs: v.number() }),
  v.object({ kind: v.literal("skipped") }),
);

export const recordStep = internalMutation({
  args: {
    evalId: v.id("evals"),
    name: stepNameLiteral,
    status: stepStatus,
  },
  returns: v.id("steps"),
  handler: async (ctx, args) => {
    const id = await ctx.db.insert("steps", {
      evalId: args.evalId,
      name: args.name,
      status: args.status,
    });
    return id;
  },
});
