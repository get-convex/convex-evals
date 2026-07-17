import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  subscriptions: defineTable({
    plan: v.string(),
    expiresAt: v.number(),
    isExpired: v.boolean(),
  }).index("by_isExpired", ["isExpired", "expiresAt"]),
});
