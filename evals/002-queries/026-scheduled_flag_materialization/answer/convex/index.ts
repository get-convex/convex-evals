import { query } from "./_generated/server";

export const listActive = query({
  args: {},
  handler: async (ctx) => {
    // Expiry state is materialized into `isExpired` by the cron in
    // `crons.ts`, so this query never reads the wall clock: it stays
    // cacheable and re-runs reactively when the flag flips.
    return await ctx.db
      .query("subscriptions")
      .withIndex("by_isExpired", (q) => q.eq("isExpired", false))
      .collect();
  },
});
