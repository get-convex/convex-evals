import { mutation } from "./_generated/server";
import { v } from "convex/values";

/**
 * Send a message with author and body.
 */
export const sendMessage = mutation({
  args: {
    author: v.string(),
    body: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("messages", {
      author: args.author,
      body: args.body,
    });
  },
});