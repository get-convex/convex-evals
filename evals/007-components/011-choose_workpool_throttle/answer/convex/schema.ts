import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  orderExports: defineTable({
    exportKey: v.string(),
    status: v.string(),
  }),
});
