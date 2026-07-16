import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { components } from "./_generated/api";
import { DataModel } from "./_generated/dataModel";
import { TableAggregate } from "@convex-dev/aggregate";

const scoreAggregate = new TableAggregate<{
  Key: number;
  DataModel: DataModel;
  TableName: "scores";
}>(components.aggregate, {
  // Negate the score so ascending key order is descending score order.
  sortKey: (doc) => -doc.score,
});

export const submitScore = mutation({
  args: {
    userId: v.string(),
    score: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("scores")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .unique();
    if (existing !== null) {
      // The aggregate must be updated in the same mutation as the table
      // write so the two can never drift.
      await ctx.db.patch("scores", existing._id, { score: args.score });
      const updated = (await ctx.db.get("scores", existing._id))!;
      await scoreAggregate.replace(ctx, existing, updated);
      return existing._id;
    }
    const id = await ctx.db.insert("scores", {
      userId: args.userId,
      score: args.score,
    });
    const doc = (await ctx.db.get("scores", id))!;
    await scoreAggregate.insert(ctx, doc);
    return id;
  },
});

export const getRank = query({
  args: {
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    const doc = await ctx.db
      .query("scores")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .unique();
    if (doc === null) {
      return null;
    }
    // Rank = users with a strictly higher score + 1, so equal scores share
    // a rank. Keys are negated scores, so "strictly higher score" means
    // "strictly lower key".
    const higher = await scoreAggregate.count(ctx, {
      bounds: { upper: { key: -doc.score, inclusive: false } },
    });
    return higher + 1;
  },
});

export const getCount = query({
  args: {},
  handler: async (ctx) => {
    return await scoreAggregate.count(ctx);
  },
});
