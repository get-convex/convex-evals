import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  fetchResults: defineTable({
    url: v.string(),
    data: v.any(),
  }),
});
