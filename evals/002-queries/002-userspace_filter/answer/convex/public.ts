import { v } from "convex/values";
import { query } from "./_generated/server";

export const getPopularPinnedMessages = query({
  args: {
    author: v.string(),
    minLikes: v.number(),
  },
  handler: async (ctx, args) => {
    const messages = await ctx.db
      .query("messages")
      .withIndex("by_author", (q) => q.eq("author", args.author))
      .collect();
    return messages
      .filter((msg) => msg.isPinned && msg.likes >= args.minLikes)
      .sort((a, b) => b.likes - a.likes);
  },
});
