import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  messages: defineTable({
    authorTokenIdentifier: v.string(),
    body: v.string(),
  }),
});
