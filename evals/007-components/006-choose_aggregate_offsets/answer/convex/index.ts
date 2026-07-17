import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { components } from "./_generated/api";
import { DataModel } from "./_generated/dataModel";
import { TableAggregate } from "@convex-dev/aggregate";

const entryAggregate = new TableAggregate<{
  Key: number;
  DataModel: DataModel;
  TableName: "entries";
}>(components.aggregate, {
  // Negate points so ascending key order is descending points order.
  sortKey: (doc) => -doc.points,
});

export const addEntry = mutation({
  args: {
    title: v.string(),
    points: v.number(),
  },
  handler: async (ctx, args) => {
    const id = await ctx.db.insert("entries", {
      title: args.title,
      points: args.points,
    });
    const doc = (await ctx.db.get("entries", id))!;
    await entryAggregate.insert(ctx, doc);
    return id;
  },
});

export const entryAt = query({
  args: {
    offset: v.number(),
  },
  handler: async (ctx, args) => {
    const item = await entryAggregate.at(ctx, args.offset);
    const doc = (await ctx.db.get("entries", item.id))!;
    return doc.title;
  },
});

export const getCount = query({
  args: {},
  handler: async (ctx) => {
    return await entryAggregate.count(ctx);
  },
});
