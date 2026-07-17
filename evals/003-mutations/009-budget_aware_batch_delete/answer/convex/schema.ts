import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  records: defineTable({
    workspaceId: v.string(),
    archived: v.boolean(),
    payload: v.string(),
  }).index("by_workspaceId_archived", ["workspaceId", "archived"]),
});
