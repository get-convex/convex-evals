import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  auditEntries: defineTable({
    workspaceId: v.string(),
    sequence: v.number(),
    status: v.union(v.literal("ok"), v.literal("failed")),
    payload: v.string(),
  }).index("by_workspaceId_and_sequence", ["workspaceId", "sequence"]),
});
