import { v } from "convex/values";
import { internalMutation, mutation } from "./_generated/server";
import { components, internal } from "./_generated/api";
import { Workpool } from "@convex-dev/workpool";

// maxParallelism: 1 serializes every queued statistics update: exactly one
// runs at a time, so writes to the hot "global" document never race each
// other, while recordEvent itself stays append-only and conflict-free.
const statsPool = new Workpool(components.workpool, { maxParallelism: 1 });

export const recordEvent = mutation({
  args: {
    kind: v.string(),
    value: v.number(),
  },
  handler: async (ctx, args) => {
    const eventId = await ctx.db.insert("events", {
      kind: args.kind,
      value: args.value,
    });
    await statsPool.enqueueMutation(ctx, internal.index.updateStatistics, {
      value: args.value,
    });
    return eventId;
  },
});

export const updateStatistics = internalMutation({
  args: {
    value: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("statistics")
      .withIndex("by_key", (q) => q.eq("key", "global"))
      .unique();
    if (existing === null) {
      await ctx.db.insert("statistics", {
        key: "global",
        eventCount: 1,
        valueSum: args.value,
      });
      return;
    }
    await ctx.db.patch("statistics", existing._id, {
      eventCount: existing.eventCount + 1,
      valueSum: existing.valueSum + args.value,
    });
  },
});
