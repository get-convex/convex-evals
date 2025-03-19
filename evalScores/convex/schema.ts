import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  evalScores: defineTable({
    model: v.string(),
    scores: v.record(v.string(), v.number()),
    totalScore: v.optional(v.number()),
    updatedAt: v.optional(v.number()),
  }).index("by_model", ["model"]),

  authTokens: defineTable({
    name: v.string(),
    value: v.string(),
    createdAt: v.number(),
    lastUsed: v.optional(v.number()),
  })
    .index("by_value", ["value"])
    .index("by_name", ["name"]),
});
