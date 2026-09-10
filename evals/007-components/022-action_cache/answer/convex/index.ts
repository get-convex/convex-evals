import { v } from "convex/values";
import { ActionCache } from "@convex-dev/action-cache";
import { action, internalAction } from "./_generated/server";
import { components, internal } from "./_generated/api";

type Description = { text: string; generationId: string };

export const generateDescription = internalAction({
  args: { productId: v.string(), language: v.string() },
  handler: async (_ctx, args): Promise<Description> => ({
    text: `${args.productId}:${args.language}`,
    generationId: crypto.randomUUID(),
  }),
});

const cache = new ActionCache(components.actionCache, {
  action: internal.index.generateDescription,
  ttl: 60 * 60 * 1000,
});

export const getDescription = action({
  args: {
    productId: v.string(),
    language: v.string(),
    maxAgeMs: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<Description> => {
    // Freshness controls cache lookup, not the identity of the generated value.
    return await cache.fetch(
      ctx,
      { productId: args.productId, language: args.language },
      { ttl: args.maxAgeMs },
    );
  },
});
