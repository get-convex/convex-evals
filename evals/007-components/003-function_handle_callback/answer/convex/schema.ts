import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  completions: defineTable({
    jobKey: v.string(),
  }).index("by_jobKey", ["jobKey"]),
});
