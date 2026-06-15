import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const get = query({
  args: { id: v.id("users") },
  handler: async (ctx, args) => {
    const user = await ctx.db.get("users", args.id);
    if (!user) {
      throw new Error("User not found");
    }
    return user;
  },
});

export const create = mutation({
  args: {
    name: v.string(),
    email: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await ctx.db.insert("users", {
      name: args.name,
      email: args.email,
    });
    return userId;
  },
});

export const destroy = mutation({
  args: {
    id: v.id("users"),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get("users", args.id);
    if (!existing) {
      throw new Error("User not found");
    }
    await ctx.db.delete("users", args.id);
    return null;
  },
});