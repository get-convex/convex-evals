import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  scores: defineTable({
    player: v.string(),
    points: v.number(),
  }).index("by_points", ["points"]),
});
