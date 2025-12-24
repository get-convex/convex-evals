import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // Each record is a single eval run for a model (append-only for history)
  evalScores: defineTable({
    model: v.string(),
    scores: v.record(v.string(), v.number()),
    totalScore: v.number(),
    // Optional run identifier (e.g. git sha, date string)
    runId: v.optional(v.string()),
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
