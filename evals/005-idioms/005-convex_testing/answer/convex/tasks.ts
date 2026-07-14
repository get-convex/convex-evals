import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const list = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("tasks").order("desc").collect();
  },
});

export const create = mutation({
  args: { text: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db.insert("tasks", {
      text: args.text,
      isCompleted: false,
    });
  },
});

export const complete = mutation({
  args: { id: v.id("tasks") },
  handler: async (ctx, args) => {
    await ctx.db.patch("tasks", args.id, { isCompleted: true });
    return null;
  },
});

export const remove = mutation({
  args: { id: v.id("tasks") },
  handler: async (ctx, args) => {
    await ctx.db.delete("tasks", args.id);
    return null;
  },
});
