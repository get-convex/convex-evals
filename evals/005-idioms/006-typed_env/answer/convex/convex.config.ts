import { defineApp } from "convex/server";
import { v } from "convex/values";

export default defineApp({
  env: {
    SUPPORT_EMAIL: v.optional(v.string()),
    DEPLOYMENT_STAGE: v.optional(
      v.union(v.literal("dev"), v.literal("preview"), v.literal("prod")),
    ),
  },
});
