import { query } from "./_generated/server";
import { v } from "convex/values";

export const searchPostsWithAuthors = query({
  args: { query: v.string() },
  handler: async (ctx, args) => {
    // Search posts using the search index
    const posts = await ctx.db
      .query("posts")
      .withSearchIndex("search", (q) => q.search("content", args.query))
      .collect();

    // Transform the results to include author information
    return await Promise.all(posts.map(async (post) => ({
      title: post.title,
      content: post.content,
      author: (await ctx.db.get(post.authorId))?.name ?? "Unknown Author",
    })));
  },
});