import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

export const recordHeartbeat = mutation({
  args: { userId: v.id("users"), nowMs: v.number() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("userPresence")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .unique();

    if (existing) {
      await ctx.db.patch("userPresence", existing._id, { lastHeartbeatMs: args.nowMs });
      return existing._id;
    }

    return await ctx.db.insert("userPresence", {
      userId: args.userId,
      lastHeartbeatMs: args.nowMs,
    });
  },
});

export const listOnlineUsers = query({
  args: {
    activeWithinMs: v.number(),
    nowMs: v.number(),
  },
  handler: async (ctx, args) => {
    const threshold = args.nowMs - args.activeWithinMs;
    const presenceRows = await ctx.db.query("userPresence").collect();

    const activeRows = presenceRows.filter(
      (presence) => presence.lastHeartbeatMs >= threshold,
    );

    const joined = await Promise.all(
      activeRows.map(async (presence) => {
        const user = await ctx.db.get("users", presence.userId);
        if (!user) return null;
        return {
          userId: user._id,
          name: user.name,
          email: user.email,
          lastHeartbeatMs: presence.lastHeartbeatMs,
        };
      }),
    );

    return joined.flatMap((row) => (row ? [row] : []));
  },
});
