import { v } from "convex/values";
import { query } from "./_generated/server";

export const getCustomerStats = query({
  args: { customerId: v.string() },
  handler: async (ctx, args) => {
    const orders = await ctx.db
      .query("orders")
      .withIndex("by_customer", (q) => q.eq("customerId", args.customerId))
      .collect();
    const stats = orders.reduce(
      (acc, order) => ({
        totalOrders: acc.totalOrders + 1,
        totalItems: acc.totalItems + order.quantity,
        totalSpent: acc.totalSpent + order.quantity * order.pricePerUnit,
      }),
      { totalOrders: 0, totalItems: 0, totalSpent: 0 },
    );
    return {
      totalOrders: stats.totalOrders,
      totalItems: stats.totalItems,
      totalSpent: Number(stats.totalSpent.toFixed(2)),
      averageOrderValue:
        stats.totalOrders &&
        Number((stats.totalSpent / stats.totalOrders).toFixed(2)),
    };
  },
});
