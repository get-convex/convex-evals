import { defineSchema, defineTable } from "convex/server";
import { articleFields } from "./index";

export default defineSchema({
  articles: defineTable(articleFields),
});
