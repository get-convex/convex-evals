import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  events: defineTable({
    kind: v.string(),
    value: v.number(),
  }),
  statistics: defineTable({
    key: v.string(),
    eventCount: v.number(),
    valueSum: v.number(),
  }).index("by_key", ["key"]),
});
