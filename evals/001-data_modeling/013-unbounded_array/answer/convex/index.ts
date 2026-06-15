import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

export const createTask = mutation({
  args: {
    title: v.string(),
    status: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("tasks", {
      title: args.title,
      status: args.status,
    });
  },
});

export const addChecklistItem = mutation({
  args: {
    taskId: v.id("tasks"),
    text: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("checklistItems", {
      taskId: args.taskId,
      text: args.text,
      completed: false,
    });
  },
});

export const toggleChecklistItem = mutation({
  args: {
    itemId: v.id("checklistItems"),
  },
  handler: async (ctx, args) => {
    const item = await ctx.db.get("checklistItems", args.itemId);
    if (!item) throw new Error("Checklist item not found");
    await ctx.db.patch("checklistItems", args.itemId, { completed: !item.completed });
  },
});

export const getChecklistItems = query({
  args: {
    taskId: v.id("tasks"),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("checklistItems")
      .withIndex("by_taskId", (q) => q.eq("taskId", args.taskId))
      .collect();
  },
});
