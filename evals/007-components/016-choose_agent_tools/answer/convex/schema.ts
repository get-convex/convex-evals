import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  products: defineTable({
    name: v.string(),
    stock: v.number(),
  }).index("by_name", ["name"]),
  orders: defineTable({
    orderNumber: v.string(),
    status: v.string(),
  }).index("by_orderNumber", ["orderNumber"]),
});
