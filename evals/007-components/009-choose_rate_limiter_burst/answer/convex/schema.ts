import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  searches: defineTable({
    searcherTokenIdentifier: v.string(),
    term: v.string(),
  }),
});
