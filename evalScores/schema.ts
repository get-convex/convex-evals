import { defineTable } from "convex/server";
import { defineSchema } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  evalScores: defineTable({
    model: v.string(),
    eval: v.record(v.string(), v.number()),
  }),
});
