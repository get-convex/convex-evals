import { v } from "convex/values";
import { createFunctionHandle } from "convex/server";
import { internalMutation, mutation, query } from "./_generated/server";
import { components, internal } from "./_generated/api";

export const recordCompletion = internalMutation({
  args: {
    jobKey: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("completions", { jobKey: args.jobKey });
    return null;
  },
});

export const runJob = mutation({
  args: {
    jobKey: v.string(),
  },
  handler: async (ctx, args) => {
    const handle = await createFunctionHandle(internal.index.recordCompletion);
    await ctx.runMutation(components.jobRunner.index.run, {
      handle,
      jobKey: args.jobKey,
    });
    return null;
  },
});

export const getCompletionCount = query({
  args: {
    jobKey: v.string(),
  },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("completions")
      .withIndex("by_jobKey", (q) => q.eq("jobKey", args.jobKey))
      .collect();
    return rows.length;
  },
});
