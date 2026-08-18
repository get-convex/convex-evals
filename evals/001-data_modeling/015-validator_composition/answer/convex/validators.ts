import { v } from "convex/values";

// Application fields live in one reusable validator. The schema and function
// validators below derive their shapes from this single definition.
export const articleFieldsValidator = v.object({
  title: v.string(),
  body: v.string(),
  slug: v.string(),
});
