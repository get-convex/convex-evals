import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

export const createTicket = mutation({
  args: {
    orgId: v.string(),
    title: v.string(),
    status: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("tickets", {
      orgId: args.orgId,
      title: args.title,
      status: args.status,
    });
    const existing = await ctx.db
      .query("ticketCounts")
      .withIndex("by_orgId", (q) => q.eq("orgId", args.orgId))
      .unique();
    if (existing) {
      await ctx.db.patch("ticketCounts", existing._id, { count: existing.count + 1 });
    } else {
      await ctx.db.insert("ticketCounts", { orgId: args.orgId, count: 1 });
    }
  },
});

export const getTicketCount = query({
  args: {
    orgId: v.string(),
  },
  handler: async (ctx, args) => {
    const counter = await ctx.db
      .query("ticketCounts")
      .withIndex("by_orgId", (q) => q.eq("orgId", args.orgId))
      .unique();
    return counter?.count ?? 0;
  },
});
