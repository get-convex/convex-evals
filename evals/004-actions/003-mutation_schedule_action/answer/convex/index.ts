import { mutation, internalMutation, internalAction } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import schema from "./schema";

export const initiateRequest = mutation({
  args: { url: v.string() },
  handler: async (ctx, args) => {
    // Check if URL already exists
    const existing = await ctx.db
      .query("requests")
      .withIndex("by_url", (q) => q.eq("url", args.url))
      .unique();

    if (existing) {
      return existing._id;
    }

    // Create new request record
    const requestId = await ctx.db.insert("requests", {
      url: args.url,
      status: "pending",
      requestedAt: Date.now(),
    });

    // Schedule the HTTP fetch
    await ctx.scheduler.runAfter(0, internal.index.performHttpbinFetch, {
      url: args.url,
      requestId,
    });

    return requestId;
  },
});

export const performHttpbinFetch = internalAction({
  args: {
    url: v.string(),
    requestId: v.id("requests"),
  },
  handler: async (ctx, args) => {
    try {
      // Perform the HTTP POST request
      const response = await fetch(args.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ timestamp: Date.now() }),
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      // Update the request status
      await ctx.runMutation(internal.index.updateRequest, {
        requestId: args.requestId,
        status: "completed",
        completedAt: Date.now(),
      });
    } catch (error) {
      console.error("Error performing HTTP fetch:", error);
      throw error;
    }
    return null;
  },
});

export const updateRequest = internalMutation({
  args: {
    requestId: v.id("requests"),
    status: schema.tables.requests.validator.fields.status,
    completedAt: v.number(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.requestId, {
      status: args.status,
      completedAt: args.completedAt,
    });
    return null;
  },
});