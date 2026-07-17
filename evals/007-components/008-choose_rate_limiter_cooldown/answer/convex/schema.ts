import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  otpRequests: defineTable({
    requesterTokenIdentifier: v.string(),
  }),
});
