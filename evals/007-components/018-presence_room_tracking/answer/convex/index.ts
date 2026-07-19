import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { components } from "./_generated/api";
import { Presence } from "@convex-dev/presence";

const presence = new Presence(components.presence);

export const heartbeat = mutation({
  args: {
    roomId: v.string(),
    userId: v.string(),
    sessionId: v.string(),
    interval: v.number(),
  },
  handler: async (ctx, { roomId, userId, sessionId, interval }) => {
    // Pass the caller's interval through unchanged: the component times a
    // session out when no heartbeat arrives for ~2.5x this interval.
    return await presence.heartbeat(ctx, roomId, userId, sessionId, interval);
  },
});

export const list = query({
  args: {
    roomToken: v.string(),
  },
  handler: async (ctx, { roomToken }) => {
    // One entry per user; offline users stay listed with `online: false`.
    return await presence.list(ctx, roomToken);
  },
});

export const disconnect = mutation({
  args: {
    sessionToken: v.string(),
  },
  handler: async (ctx, { sessionToken }) => {
    return await presence.disconnect(ctx, sessionToken);
  },
});
