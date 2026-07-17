import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

export const articleDocValidator = v.object({
  _id: v.id("articles"),
  _creationTime: v.number(),
  title: v.string(),
  body: v.string(),
  slug: v.string(),
});

// Every shape below derives from the base - no field validator is written twice.
export const articleFields = articleDocValidator.omit("_id", "_creationTime");
export const createArticleArgs = articleFields.omit("slug");
export const updateArticleArgs = createArticleArgs
  .partial()
  .extend({ articleId: v.id("articles") });
export const articleResponseValidator = articleDocValidator.extend({
  excerpt: v.string(),
});

function slugify(title: string): string {
  return title.toLowerCase().replaceAll(" ", "-");
}

export const createArticle = mutation({
  args: createArticleArgs.fields,
  handler: async (ctx, args) => {
    return await ctx.db.insert("articles", {
      title: args.title,
      body: args.body,
      slug: slugify(args.title),
    });
  },
});

export const updateArticle = mutation({
  args: updateArticleArgs.fields,
  handler: async (ctx, args) => {
    const { articleId, ...changes } = args;
    const patch: Record<string, string> = {};
    if (changes.title !== undefined) {
      patch.title = changes.title;
      patch.slug = slugify(changes.title);
    }
    if (changes.body !== undefined) {
      patch.body = changes.body;
    }
    await ctx.db.patch("articles", articleId, patch);
    return null;
  },
});

export const getArticle = query({
  args: { articleId: v.id("articles") },
  returns: articleResponseValidator,
  handler: async (ctx, args) => {
    const article = await ctx.db.get("articles", args.articleId);
    if (article === null) {
      throw new Error("Article not found");
    }
    return { ...article, excerpt: article.body.slice(0, 20) };
  },
});
