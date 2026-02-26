import { mutation, action } from "./_generated/server";
import { v } from "convex/values";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";

export const saveFetchResult = mutation({
  args: {
    url: v.string(),
    data: v.any(),
  },
  handler: async (ctx, args): Promise<Id<"fetchResults">> => {
    return await ctx.db.insert("fetchResults", args);
  },
});

export const fetchAndSave = action({
  args: {
    url: v.string(),
  },
  handler: async (ctx, args): Promise<Id<"fetchResults">> => {
    const response = await fetch(args.url);
    const data = await response.json();

    return await ctx.runMutation(api.index.saveFetchResult, {
      url: args.url,
      data,
    });
  },
});