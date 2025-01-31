import { query, mutation, action, internalAction, internalMutation } from "./_generated/server";
import { v } from "convex/values";

/**
 * Public query that returns static stats.
 * Accessible to client applications.
 */
export const getPublicStats = query({
  args: {},
  returns: v.object({
    totalUsers: v.number(),
    version: v.string(),
  }),
  handler: async (ctx) => {
    return {
      totalUsers: 100,
      version: "1.0.0",
    };
  },
});

/**
 * Public mutation that logs client events.
 * Accessible to client applications.
 */
export const logClientEvent = mutation({
  args: {
    eventName: v.string(),
    data: v.any(),
  },
  returns: v.number(),
  handler: async (ctx, args) => {
    console.log(`Event: ${args.eventName}`, args.data);
    return Date.now();
  },
});

/**
 * Internal action for system maintenance.
 * Not accessible to clients.
 */
export const dailyCleanup = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    console.log("Running daily cleanup");
    return null;
  },
});

/**
 * Internal mutation for system reset.
 * Not accessible to clients.
 */
export const resetCounter = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    console.log("Resetting counter");
    return null;
  },
});