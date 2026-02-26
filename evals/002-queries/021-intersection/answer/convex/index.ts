import { query } from "./_generated/server";
import { v } from "convex/values";

export const getActiveUsersWithPosts = query({
  args: {},
  handler: async (ctx) => {
    // Get all active users using the by_status index
    const activeUsers = await ctx.db
      .query("users")
      .withIndex("by_status", (q) => q.eq("status", "active"))
      .collect();

    // For each user, fetch their posts and combine the data
    const usersWithPosts = await Promise.all(
      activeUsers.map(async (user) => {
        // Get published posts for this user using the by_published index
        const userPosts = await ctx.db
          .query("posts")
          .withIndex("by_published", (q) =>
            q.eq("authorId", user._id).eq("published", true)
          )
          .collect();

        // Format posts to only include required fields
        const formattedPosts = userPosts.map((post) => ({
          title: post.title,
        }));

        // Return combined user and posts data in required format
        return {
          userId: user._id,
          name: user.name,
          posts: formattedPosts,
        };
      })
    );

    return usersWithPosts;
  },
});