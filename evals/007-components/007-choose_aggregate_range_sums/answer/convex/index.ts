import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { components } from "./_generated/api";
import { DataModel } from "./_generated/dataModel";
import { TableAggregate } from "@convex-dev/aggregate";

const transactionAggregate = new TableAggregate<{
  Key: number;
  DataModel: DataModel;
  TableName: "transactions";
}>(components.aggregate, {
  sortKey: (doc) => doc.happenedAt,
  sumValue: (doc) => doc.amount,
});

export const recordTransaction = mutation({
  args: {
    amount: v.number(),
    happenedAt: v.number(),
  },
  handler: async (ctx, args) => {
    const id = await ctx.db.insert("transactions", {
      amount: args.amount,
      happenedAt: args.happenedAt,
    });
    const doc = (await ctx.db.get("transactions", id))!;
    await transactionAggregate.insert(ctx, doc);
    return id;
  },
});

export const sumInRange = query({
  args: {
    start: v.number(),
    end: v.number(),
  },
  handler: async (ctx, args) => {
    return await transactionAggregate.sum(ctx, {
      bounds: {
        lower: { key: args.start, inclusive: true },
        upper: { key: args.end, inclusive: false },
      },
    });
  },
});
