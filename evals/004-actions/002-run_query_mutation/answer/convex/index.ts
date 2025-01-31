import { internalQuery, internalMutation, action } from "./_generated/server";
import { v } from "convex/values";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";

export const getFetchResult = internalQuery({
  args: { url: v.string() },
  handler: async (ctx, args): Promise<Id<"fetchRequests"> | null> => {
    const result = await ctx.db
      .query("fetchRequests")
      .withIndex("by_url", (q) => q.eq("url", args.url))
      .first();
    return result?._id ?? null;
  },
});

export const saveFetchResult = internalMutation({
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
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      await ctx.db.patch(existing._id, { data: args.data });
      return existing._id;
    }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { url, data } = args;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const id = await ctx.db.insert("fetchRequests", { url, data });
    return id;
  },
});

export const fetchIfNeeded = action({
  args: { url: v.string() },
  handler: async (ctx, args): Promise<Id<"fetchRequests">> => {
    const existing = await ctx.runQuery(internal.index.getFetchResult, { url: args.url });

    if (existing) {
      return existing;
    }

    const response = await fetch(args.url);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const data = await response.json();

    if (!response.ok) {
      throw new Error(`Failed to fetch ${args.url}: ${response.statusText}`);
    }

    const id = await ctx.runMutation(internal.index.saveFetchResult, {
      url: args.url,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      data,
    });

    return id;
  },
});