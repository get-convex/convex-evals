import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  documents: defineTable({
    workspaceId: v.string(),
    status: v.string(),
    title: v.string(),
  })
    .index("by_workspaceId", ["workspaceId"])
    // Staged: backfills asynchronously so the deploy does not block; a
    // later deploy removes the flag to enable querying it.
    .index("by_workspaceId_and_status", {
      fields: ["workspaceId", "status"],
      staged: true,
    }),
});
