import { query } from "./_generated/server";
import { v } from "convex/values";

/**
 * Query active users who are at least the specified age.
 * Uses the "by_age" index for efficient querying and filters out deleted users.
 */
export const getActiveAdults = query({
  args: { minAge: v.number() },
  handler: async (ctx, args) => {
    // Use the "by_age" index to efficiently filter users by age
    const users = await ctx.db
      .query("users")
      .withIndex("by_age", (q) => q.gte("age", args.minAge))
      .filter((q) => q.eq(q.field("isDeleted"), false))
      .collect();

    // Map the results to return only the names
    return users.map((user) => user.name);
  },
});