import { v } from "convex/values";
import { query } from "./_generated/server";

export const listActive = query({
  args: {
    now: v.number(),
  },
  handler: async (ctx, args) => {
    // The caller supplies the current time; reading the wall clock here
    // would break query caching and reactivity.
    return await ctx.db
      .query("items")
      .withIndex("by_expiresAt", (q) => q.gt("expiresAt", args.now))
      .take(100);
  },
});
