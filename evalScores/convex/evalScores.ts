import { internalMutation, query } from "./_generated/server";
import { v } from "convex/values";

/**
 * Updates or creates the scores for a given model.
 *
 * If a record with the provided model name exists, it will update the scores,
 * merging with existing scores. If the record doesn't exist, a new one will be created.
 */
export const updateScores = internalMutation({
  args: {
    model: v.string(),
    scores: v.record(v.string(), v.number()),
    totalScore: v.number(),
  },
  returns: v.id("evalScores"),
  handler: async (ctx, args) => {
    // Check if we already have scores for this model
    const existingScores = await ctx.db
      .query("evalScores")
      .withIndex("by_model", (q) => q.eq("model", args.model))
      .unique();

    if (existingScores) {
      // Update the existing record
      await ctx.db.patch(existingScores._id, {
        scores: args.scores,
        totalScore: args.totalScore,
        updatedAt: Date.now(),
      });

      return existingScores._id;
    } else {
      // Create a new record
      const id = await ctx.db.insert("evalScores", {
        model: args.model,
        scores: args.scores,
        totalScore: args.totalScore,
        updatedAt: Date.now(),
      });

      return id;
    }
  },
});

/**
 * Retrieves scores for a specific model.
 */
export const getScores = query({
  args: {
    model: v.string(),
  },
  returns: v.union(
    v.object({
      _id: v.id("evalScores"),
      model: v.string(),
      totalScore: v.optional(v.number()),
      scores: v.record(v.string(), v.number()),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const scores = await ctx.db
      .query("evalScores")
      .withIndex("by_model", (q) => q.eq("model", args.model))
      .unique();

    return scores;
  },
});

/**
 * Lists all models with their scores.
 */
export const listAllScores = query({
  args: {},
  returns: v.array(
    v.object({
      _creationTime: v.number(),
      _id: v.id("evalScores"),
      model: v.string(),
      totalScore: v.optional(v.number()),
      scores: v.record(v.string(), v.number()),
      updatedAt: v.optional(v.number()),
    }),
  ),
  handler: async (ctx) => {
    const allScores = await ctx.db.query("evalScores").collect();
    return allScores;
  },
});
