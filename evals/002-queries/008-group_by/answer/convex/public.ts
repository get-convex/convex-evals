import { v } from "convex/values";
import { query } from "./_generated/server";

export const getMonthlySalesByCategory = query({
  args: {
    region: v.string(),
    date: v.string(),
  },
  handler: async (ctx, args) => {
    const sales = await ctx.db
      .query("sales")
      .withIndex("by_region_date", (q) =>
        q.eq("region", args.region).eq("date", args.date),
      )
      .collect();

    const resultByCategory: Record<
      string,
      {
        category: string;
        totalSales: number;
        numberOfSales: number;
        totalAmount: number;
      }
    > = {};

    for (const sale of sales) {
      let result = resultByCategory[sale.category];
      if (!result) {
        result = {
          category: sale.category,
          totalSales: 0,
          numberOfSales: 0,
          totalAmount: 0,
        };
        resultByCategory[sale.category] = result;
      }
      result.totalSales += sale.amount;
      result.numberOfSales += 1;
      result.totalAmount += sale.amount;
    }

    return Object.values(resultByCategory)
      .sort((a, b) => b.totalSales - a.totalSales)
      .map((group) => ({
        category: group.category,
        totalSales: Number(group.totalSales.toFixed(2)),
        averageSaleAmount: Number(
          (group.totalAmount / group.numberOfSales).toFixed(2),
        ),
        numberOfSales: group.numberOfSales,
      }));
  },
});
