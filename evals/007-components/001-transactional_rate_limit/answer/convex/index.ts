import { v } from "convex/values";
import { ConvexError } from "convex/values";
import { mutation } from "./_generated/server";
import { components } from "./_generated/api";
import { RateLimiter, HOUR } from "@convex-dev/rate-limiter";

const rateLimiter = new RateLimiter(components.rateLimiter, {
  sendMessage: { kind: "fixed window", rate: 2, period: HOUR },
});

export const sendMessage = mutation({
  args: {
    body: v.string(),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (identity === null) {
      throw new ConvexError("Not authenticated");
    }

    // Consume the limit first. If validation below throws, the whole
    // mutation - including the component's consumed token - rolls back,
    // so a rejected message never uses up quota.
    await rateLimiter.limit(ctx, "sendMessage", {
      key: identity.tokenIdentifier,
      throws: true,
    });

    if (args.body.trim() === "") {
      throw new ConvexError("Message body must not be empty");
    }

    return await ctx.db.insert("messages", {
      authorTokenIdentifier: identity.tokenIdentifier,
      body: args.body,
    });
  },
});
