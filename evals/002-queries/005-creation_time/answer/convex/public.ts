import { v } from "convex/values";
import { query } from "./_generated/server";

export const getPostComments = query({
  args: { postId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("comments")
      .withIndex("by_post", (q) => q.eq("postId", args.postId))
      .order("desc")
      .collect();
  },
});
