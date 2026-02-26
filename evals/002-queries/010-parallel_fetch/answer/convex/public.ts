import { v } from "convex/values";
import { query } from "./_generated/server";

export const getAuthorDashboard = query({
  args: { email: v.string() },
  handler: async (ctx, args) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", args.email))
      .unique();
    if (!user) {
      return null;
    }
    const preferencesPromise = ctx.db
      .query("userPreferences")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .unique();

    const postQuery = ctx.db
      .query("posts")
      .withIndex("by_author", (q) => q.eq("authorId", user._id))
      .order("desc");

    let numPosts = 0;
    const promises = [];
    for await (const post of postQuery) {
      numPosts++;
      if (numPosts > 15) {
        break;
      }
      const promise = async () => {
        const reactions = await ctx.db
          .query("reactions")
          .withIndex("by_post", (q) => q.eq("postId", post._id))
          .collect();
        const reactionCounts = { like: 0, heart: 0, celebrate: 0 };
        for (const reaction of reactions) {
          reactionCounts[reaction.type]++;
        }
        return {
          title: post.title,
          reactionCounts,
        };
      };
      promises.push(promise());
    }
    const posts = await Promise.all(promises);
    const preference = await preferencesPromise;
    if (!preference) {
      throw new Error("Preferences not found");
    }
    return {
      user: {
        name: user.name,
        email: user.email,
        theme: preference.theme,
        notifications: preference.notifications,
      },
      posts,
    };
  },
});
