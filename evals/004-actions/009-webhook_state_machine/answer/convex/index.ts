import { internalMutation } from "./_generated/server";
import { v } from "convex/values";

export const processBillingEvent = internalMutation({
  args: {
    eventId: v.string(),
    subscriptionId: v.string(),
    sequence: v.number(),
    state: v.union(
      v.literal("active"),
      v.literal("past_due"),
      v.literal("canceled"),
    ),
  },
  handler: async (ctx, args) => {
    const existingReceipt = await ctx.db
      .query("receipts")
      .withIndex("by_eventId", (q) => q.eq("eventId", args.eventId))
      .unique();
    if (existingReceipt !== null) {
      return "duplicate";
    }

    const subscription = await ctx.db
      .query("subscriptions")
      .withIndex("by_subscriptionId", (q) =>
        q.eq("subscriptionId", args.subscriptionId),
      )
      .unique();

    if (subscription === null) {
      await ctx.db.insert("subscriptions", {
        subscriptionId: args.subscriptionId,
        state: args.state,
        sequence: args.sequence,
      });
      await ctx.db.insert("receipts", {
        eventId: args.eventId,
        outcome: "applied",
      });
      return "applied";
    }

    if (args.sequence > subscription.sequence) {
      await ctx.db.patch(subscription._id, {
        state: args.state,
        sequence: args.sequence,
      });
      await ctx.db.insert("receipts", {
        eventId: args.eventId,
        outcome: "applied",
      });
      return "applied";
    }

    await ctx.db.insert("receipts", {
      eventId: args.eventId,
      outcome: "ignored",
    });
    return "ignored";
  },
});
