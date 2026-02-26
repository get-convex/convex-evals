import { mutation } from "./_generated/server";
import { v } from "convex/values";

export const deleteUser = mutation({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    // Verify user exists
    const user = await ctx.db.get(args.userId);
    if (!user) {
      throw new Error("User not found");
    }

    // Get all posts by the user
    const userPosts = await ctx.db
      .query("posts")
      .withIndex("by_author", (q) => q.eq("authorId", args.userId))
      .collect();

    const userPostIds = userPosts.map(post => post._id);

    // Delete all comments and likes on user's posts
    if (userPostIds.length > 0) {
      // Delete comments on user's posts
      const commentsOnPosts = await Promise.all(
        userPostIds.map(async (postId) => {
          const comments = await ctx.db
            .query("comments")
            .withIndex("by_post", (q) => q.eq("postId", postId))
            .collect();
          return comments.map((comment) => comment._id);
        })
      );

      // Delete likes on user's posts
      const likesOnPosts = await Promise.all(
        userPostIds.map(async (postId) => {
          const likes = await ctx.db
            .query("likes")
            .withIndex("by_post", (q) => q.eq("postId", postId))
            .collect();
          return likes.map((like) => like._id);
        })
      );

      // Flatten arrays and delete
      for (const commentId of commentsOnPosts.flat()) {
        await ctx.db.delete(commentId);
      }

      for (const likeId of likesOnPosts.flat()) {
        await ctx.db.delete(likeId);
      }
    }

    // Delete all comments made by the user on any post
    const userComments = await ctx.db
      .query("comments")
      .withIndex("by_author", (q) => q.eq("authorId", args.userId))
      .collect();

    for (const comment of userComments) {
      await ctx.db.delete(comment._id);
    }

    // Delete all likes made by the user on any post
    const userLikes = await ctx.db
      .query("likes")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .collect();

    for (const like of userLikes) {
      await ctx.db.delete(like._id);
    }

    // Delete all user's posts
    for (const post of userPosts) {
      await ctx.db.delete(post._id);
    }

    // Finally, delete the user
    await ctx.db.delete(args.userId);

    return null;
  },
});