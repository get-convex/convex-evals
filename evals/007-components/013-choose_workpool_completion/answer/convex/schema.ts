import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  uploads: defineTable({
    filename: v.string(),
    status: v.string(),
  }),
  auditLog: defineTable({
    uploadId: v.id("uploads"),
    outcome: v.string(),
  }),
});
