import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  boards: defineTable({
    name: v.string(),
  }),
  shapes: defineTable(
    v.union(
      v.object({
        kind: v.literal("rect"),
        boardId: v.id("boards"),
        x: v.number(),
        y: v.number(),
        width: v.number(),
        height: v.number(),
      }),
      v.object({
        kind: v.literal("circle"),
        boardId: v.id("boards"),
        x: v.number(),
        y: v.number(),
        radius: v.number(),
      }),
      v.object({
        kind: v.literal("text"),
        boardId: v.id("boards"),
        x: v.number(),
        y: v.number(),
        text: v.string(),
      }),
    ),
  ).index("by_boardId", ["boardId"]),
});
