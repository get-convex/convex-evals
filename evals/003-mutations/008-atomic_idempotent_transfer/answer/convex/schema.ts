import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  accounts: defineTable({
    name: v.string(),
    balance: v.number(),
  }),
  transfers: defineTable({
    fromAccountId: v.id("accounts"),
    toAccountId: v.id("accounts"),
    amount: v.number(),
    idempotencyKey: v.string(),
  }).index("by_idempotencyKey", ["idempotencyKey"]),
});
