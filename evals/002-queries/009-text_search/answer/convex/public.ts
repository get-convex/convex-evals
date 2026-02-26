import { v } from "convex/values";
import { query } from "./_generated/server";

export const searchArticles = query({
  args: {
    searchTerm: v.string(),
    author: v.string(),
  },
  handler: async (ctx, args) => {
    const articles = await ctx.db
      .query("articles")
      .withSearchIndex("search_articles", (q) =>
        q
          .search("content", args.searchTerm)
          .eq("author", args.author)
          .eq("isPublished", true),
      )
      .take(10);
    return articles.map((article) => {
      let preview = article.content;
      if (preview.length > 100) {
        preview = preview.slice(0, 100);
      }
      return {
        title: article.title,
        author: article.author,
        preview,
        tags: article.tags,
      };
    });
  },
});
