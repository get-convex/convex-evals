import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";

export const markExpired = internalMutation({
  args: {},
  handler: async (ctx) => {
    // Reading the clock is fine in a mutation: this is where time-based
    // state gets materialized into the `isExpired` flag.
    const now = Date.now();
    const due = await ctx.db
      .query("subscriptions")
      .withIndex("by_isExpired", (q) =>
        q.eq("isExpired", false).lte("expiresAt", now),
      )
      .collect();
    for (const subscription of due) {
      await ctx.db.patch(subscription._id, { isExpired: true });
    }
  },
});

const crons = cronJobs();

crons.interval(
  "mark expired subscriptions",
  { minutes: 1 },
  internal.crons.markExpired,
  {},
);

export default crons;
