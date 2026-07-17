import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { query } from "./_generated/server";

export const listFailedAuditEntries = query({
  args: {
    workspaceId: v.string(),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("auditEntries")
      .withIndex("by_workspaceId_and_sequence", (q) =>
        q.eq("workspaceId", args.workspaceId),
      )
      .order("asc")
      .filter((q) => q.eq(q.field("status"), "failed"))
      .paginate(args.paginationOpts);
  },
});
