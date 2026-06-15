import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const get = query({
  args: { id: v.id("posts") },
  handler: async (ctx, args) => {
    const post = await ctx.db.get("posts", args.id);
    if (!post) {
      throw new Error("Post not found");
    }
    return post;
  },
});

export const create = mutation({
  args: {
    userId: v.id("users"),
    title: v.string(),
    content: v.string(),
  },
  handler: async (ctx, args) => {
    // Verify user exists
    const user = await ctx.db.get("users", args.userId);
    if (!user) {
      throw new Error("User not found");
    }

    const postId = await ctx.db.insert("posts", {
      userId: args.userId,
      title: args.title,
      content: args.content,
    });
    return postId;
  },
});

export const destroy = mutation({
  args: {
    id: v.id("posts"),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get("posts", args.id);
    if (!existing) {
      throw new Error("Post not found");
    }
    await ctx.db.delete("posts", args.id);
    return null;
  },
});