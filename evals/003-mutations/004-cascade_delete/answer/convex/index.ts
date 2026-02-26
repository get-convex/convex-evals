import { mutation } from "./_generated/server";
import { v } from "convex/values";

export const deleteUserAndDocuments = mutation({
  args: {
    userId: v.id("users"),
  },
  handler: async (ctx, args) => {
    // First, verify the user exists
    const user = await ctx.db.get(args.userId);
    if (!user) {
      throw new Error(`User with ID ${args.userId} not found`);
    }

    // Query all documents by this user using the by_author index
    const documents = await ctx.db
      .query("documents")
      .withIndex("by_author", (q) => q.eq("authorId", args.userId))
      .collect();

    // Delete all documents in parallel
    await Promise.all(
      documents.map(async (doc) => ctx.db.delete(doc._id))
    );

    // Delete the user
    await ctx.db.delete(args.userId);

    return null;
  },
});