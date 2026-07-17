import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  subscriptions: defineTable({
    subscriptionId: v.string(),
    state: v.union(
      v.literal("active"),
      v.literal("past_due"),
      v.literal("canceled"),
    ),
    sequence: v.number(),
  }).index("by_subscriptionId", ["subscriptionId"]),
  receipts: defineTable({
    eventId: v.string(),
    outcome: v.union(v.literal("applied"), v.literal("ignored")),
  }).index("by_eventId", ["eventId"]),
});
