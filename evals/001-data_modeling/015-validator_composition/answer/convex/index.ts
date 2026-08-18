import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import schema from "./schema";
import { articleFieldsValidator } from "./validators";

export const createArticleArgs = articleFieldsValidator.omit("slug");
export const updateArticleArgs = createArticleArgs
  .partial()
  .extend({ articleId: schema.id("articles") });
export const articleResponseValidator = schema.doc("articles").extend({
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
  args: { articleId: schema.id("articles") },
  returns: articleResponseValidator,
  handler: async (ctx, args) => {
    const article = await ctx.db.get("articles", args.articleId);
    if (article === null) {
      throw new Error("Article not found");
    }
    return { ...article, excerpt: article.body.slice(0, 20) };
  },
});
