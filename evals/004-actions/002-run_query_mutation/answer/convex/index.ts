import { query, mutation, action } from "./_generated/server";
import { v } from "convex/values";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";

export const getFetchResult = query({
  args: { url: v.string() },
  handler: async (ctx, args): Promise<Id<"fetchRequests"> | null> => {
    const result = await ctx.db
      .query("fetchRequests")
      .withIndex("by_url", (q) => q.eq("url", args.url))
      .first();
    return result?._id ?? null;
  },
});

export const saveFetchResult = mutation({
  args: {
    url: v.string(),
    data: v.any(),
  },
  handler: async (ctx, args): Promise<Id<"fetchRequests">> => {
    const existing = await ctx.db
      .query("fetchRequests")
      .withIndex("by_url", (q) => q.eq("url", args.url))
      .first();
    if (existing) {
      await ctx.db.patch("fetchRequests", existing._id, { data: args.data });
      return existing._id;
    }
    const { url, data } = args;
    const id = await ctx.db.insert("fetchRequests", { url, data });
    return id;
  },
});

export const fetchIfNeeded = action({
  args: { url: v.string() },
  handler: async (ctx, args): Promise<Id<"fetchRequests">> => {
    const existing = await ctx.runQuery(api.index.getFetchResult, {
      url: args.url,
    });

    if (existing) {
      return existing;
    }

    const response = await fetch(args.url);
    const data = await response.json();

    if (!response.ok) {
      throw new Error(`Failed to fetch ${args.url}: ${response.statusText}`);
    }

    const id = await ctx.runMutation(api.index.saveFetchResult, {
      url: args.url,
      data,
    });

    return id;
  },
});