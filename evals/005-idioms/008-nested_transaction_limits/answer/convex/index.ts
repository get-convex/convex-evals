import { v } from "convex/values";
import { internalMutation, mutation } from "./_generated/server";
import { internal } from "./_generated/api";

export const writeDeliveries = internalMutation({
  args: {
    jobId: v.id("jobs"),
    count: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    for (let i = 0; i < args.count; i++) {
      await ctx.db.insert("deliveries", {
        jobId: args.jobId,
        recipient: `recipient-${i}`,
      });
    }
    return null;
  },
});

export const processFanout = mutation({
  args: {
    jobId: v.id("jobs"),
    count: v.number(),
  },
  returns: v.union(v.literal("completed"), v.literal("rejected")),
  handler: async (ctx, args) => {
    try {
      await ctx.runMutation(
        internal.index.writeDeliveries,
        { jobId: args.jobId, count: args.count },
        { transactionLimits: { documentsWritten: 5 } },
      );
    } catch {
      // The nested mutation ran as a subtransaction, so its delivery
      // inserts rolled back; this mutation can still record the rejection.
      await ctx.db.patch("jobs", args.jobId, { status: "rejected" });
      return "rejected";
    }
    await ctx.db.patch("jobs", args.jobId, { status: "completed" });
    return "completed";
  },
});
