import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  profiles: defineTable({
    displayName: v.string(),
    bio: v.string(),
  }),
});
