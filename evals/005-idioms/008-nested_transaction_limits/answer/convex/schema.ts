import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  jobs: defineTable({
    name: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("completed"),
      v.literal("rejected"),
    ),
  }),
  deliveries: defineTable({
    jobId: v.id("jobs"),
    recipient: v.string(),
  }).index("by_jobId", ["jobId"]),
});
