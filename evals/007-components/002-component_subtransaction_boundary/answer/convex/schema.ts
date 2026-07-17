import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  auditStatuses: defineTable({
    event: v.string(),
    status: v.union(v.literal("audit_succeeded"), v.literal("audit_failed")),
  }),
});
