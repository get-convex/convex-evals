import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  documents: defineTable({
    title: v.string(),
    content: v.string(),
  }),

  accessLogs: defineTable({
    documentId: v.id("documents"),
    action: v.string(),
  }),
});