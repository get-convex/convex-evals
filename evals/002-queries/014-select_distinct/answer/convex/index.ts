import { query } from "./_generated/server";
import { v } from "convex/values";

export const getDistinctAges = query({
  args: {},
  handler: async (ctx) => {
    const distinctAges: number[] = [];
    let cursor = await ctx.db .query("users") .withIndex("by_age") .first();

    while (cursor) {
      // Get current age
      distinctAges.push(cursor.age);

      // Find the first record with an age greater than the current age
      cursor = await ctx.db .query("users") .withIndex("by_age", q => q.gt("age", cursor!.age)) .first();
    }

    return distinctAges;
  },
});