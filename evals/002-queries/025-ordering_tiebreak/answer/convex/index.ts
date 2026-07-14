import { v } from "convex/values";
import { query } from "./_generated/server";

export const topScores = query({
  args: {
    n: v.number(),
  },
  returns: v.array(
    v.object({
      _id: v.id("scores"),
      _creationTime: v.number(),
      player: v.string(),
      points: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    // Every index implicitly ends with _creationTime, so by_points orders by
    // points then creation time; .order("desc") reverses the whole key,
    // returning equal-point rows newest first.
    return await ctx.db
      .query("scores")
      .withIndex("by_points")
      .order("desc")
      .take(args.n);
  },
});
