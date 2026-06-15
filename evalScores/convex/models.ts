import { paginationOptsValidator } from "convex/server";
import { internalMutation, query } from "./_generated/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";

function inferProviderFromSlug(slug: string): string {
  const slashIndex = slug.indexOf("/");
  if (slashIndex <= 0) return "openrouter";
  return slug.slice(0, slashIndex);
}

export const upsertFromSlug = internalMutation({
  args: {
    slug: v.string(),
    formattedName: v.string(),
    provider: v.optional(v.string()),
    apiKind: v.optional(v.union(v.literal("chat"), v.literal("responses"))),
    openRouterFirstSeenAt: v.optional(v.number()),
  },
  returns: v.id("models"),
  handler: async (ctx, args): Promise<Id<"models">> => {
    const now = Date.now();
    const provider =
      args.provider && args.provider.length > 0
        ? args.provider
        : inferProviderFromSlug(args.slug);
    const apiKind = args.apiKind ?? "chat";

    const existing = await ctx.db
      .query("models")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .unique();

    if (existing) {
      await ctx.db.patch("models", existing._id, {
        formattedName: args.formattedName,
        provider,
        apiKind,
        openRouterFirstSeenAt:
          existing.openRouterFirstSeenAt ?? args.openRouterFirstSeenAt ?? now,
        updatedAt: now,
        lastSeenAt: now,
      });
      return existing._id;
    }

    return await ctx.db.insert("models", {
      slug: args.slug,
      formattedName: args.formattedName,
      provider,
      apiKind,
      openRouterFirstSeenAt: args.openRouterFirstSeenAt ?? now,
      createdAt: now,
      updatedAt: now,
      lastSeenAt: now,
    });
  },
});

export const getBySlug = query({
  args: {
    slug: v.string(),
  },
  returns: v.union(
    v.object({
      _id: v.id("models"),
      slug: v.string(),
      formattedName: v.string(),
      provider: v.string(),
      apiKind: v.union(v.literal("chat"), v.literal("responses")),
      openRouterFirstSeenAt: v.number(),
      createdAt: v.number(),
      updatedAt: v.number(),
      lastSeenAt: v.number(),
      _creationTime: v.number(),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    return await ctx.db
      .query("models")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .unique();
  },
});

export const listModels = query({
  args: {
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("models")
      .order("desc")
      .paginate(args.paginationOpts);
  },
});
