import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { components } from "./_generated/api";
import { Presence } from "@convex-dev/presence";

const presence = new Presence(components.presence);

export const docHeartbeat = mutation({
  args: {
    docId: v.string(),
    userId: v.string(),
    sessionId: v.string(),
    interval: v.number(),
  },
  handler: async (ctx, { docId, userId, sessionId, interval }) => {
    // Each document is a presence room. The component schedules the session
    // timeout, so a killed tab stops counting shortly after heartbeats stop.
    return await presence.heartbeat(ctx, docId, userId, sessionId, interval);
  },
});

export const whoIsViewing = query({
  args: {
    roomToken: v.string(),
  },
  handler: async (ctx, { roomToken }) => {
    // Reactive: entries flip to online:false on disconnect/timeout without
    // any wall-clock filtering, so subscriptions never serve stale results.
    return await presence.list(ctx, roomToken);
  },
});

export const leave = mutation({
  args: {
    sessionToken: v.string(),
  },
  handler: async (ctx, { sessionToken }) => {
    return await presence.disconnect(ctx, sessionToken);
  },
});
