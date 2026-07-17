import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  receipts: defineTable({
    jobKey: v.string(),
    kind: v.union(v.literal("success"), v.literal("failed")),
    value: v.union(v.number(), v.null()),
  }),
});
