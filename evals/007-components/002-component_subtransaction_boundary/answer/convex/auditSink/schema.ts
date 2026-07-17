import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  audits: defineTable({
    event: v.string(),
  }).index("by_event", ["event"]),
});
