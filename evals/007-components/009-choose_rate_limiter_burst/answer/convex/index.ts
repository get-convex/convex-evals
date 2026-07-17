import { v, ConvexError } from "convex/values";
import { mutation } from "./_generated/server";
import { components } from "./_generated/api";
import { RateLimiter, SECOND } from "@convex-dev/rate-limiter";

const rateLimiter = new RateLimiter(components.rateLimiter, {
  // Token bucket: bursts up to capacity, refilling at the sustained rate.
  logSearch: { kind: "token bucket", rate: 1, period: SECOND, capacity: 10 },
});

export const logSearch = mutation({
  args: {
    term: v.string(),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (identity === null) {
      throw new ConvexError("Not authenticated");
    }
    await rateLimiter.limit(ctx, "logSearch", {
      key: identity.tokenIdentifier,
      throws: true,
    });
    return await ctx.db.insert("searches", {
      searcherTokenIdentifier: identity.tokenIdentifier,
      term: args.term,
    });
  },
});
