import { ConvexError } from "convex/values";
import { mutation } from "./_generated/server";
import { components } from "./_generated/api";
import { RateLimiter, SECOND } from "@convex-dev/rate-limiter";

const rateLimiter = new RateLimiter(components.rateLimiter, {
  requestCode: { kind: "fixed window", rate: 1, period: 30 * SECOND },
});

export const requestCode = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (identity === null) {
      throw new ConvexError("Not authenticated");
    }
    await rateLimiter.limit(ctx, "requestCode", {
      key: identity.tokenIdentifier,
      throws: true,
    });
    return await ctx.db.insert("otpRequests", {
      requesterTokenIdentifier: identity.tokenIdentifier,
    });
  },
});
