import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  documents: defineTable({
    title: v.string(),
    category: v.string(),
    status: v.union(v.literal("published"), v.literal("draft")),
    embedding: v.array(v.float64()),
  }).vectorIndex("by_embedding", {
    vectorField: "embedding",
    dimensions: 4,
    filterFields: ["category"],
  }),
});
