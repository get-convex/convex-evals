import { v } from "convex/values";
import { mutation } from "./_generated/server";
import { api } from "./_generated/api";

const BATCH_SIZE = 100;

export const deleteActivityLogs = mutation({
  args: {
    workspaceId: v.string(),
  },
  handler: async (ctx, args) => {
    const batch = await ctx.db
      .query("activityLog")
      .withIndex("by_workspaceId", (q) =>
        q.eq("workspaceId", args.workspaceId),
      )
      .take(BATCH_SIZE);

    for (const entry of batch) {
      await ctx.db.delete("activityLog", entry._id);
    }

    if (batch.length === BATCH_SIZE) {
      await ctx.scheduler.runAfter(0, api.index.deleteActivityLogs, {
        workspaceId: args.workspaceId,
      });
    }
  },
});
