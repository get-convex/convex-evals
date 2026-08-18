import { defineSchema, defineTable } from "convex/server";
import { articleFieldsValidator } from "./validators";

export default defineSchema({
  articles: defineTable(articleFieldsValidator),
});
