import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  items: defineTable({
    name: v.string(),
    expiresAt: v.number(),
  }).index("by_expiresAt", ["expiresAt"]),
});
