import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { components } from "./_generated/api";
import { Presence } from "@convex-dev/presence";

const presence = new Presence(components.presence);

export const typingHeartbeat = mutation({
  args: {
    channelId: v.string(),
    userId: v.string(),
    sessionId: v.string(),
    interval: v.number(),
  },
  handler: async (ctx, { channelId, userId, sessionId, interval }) => {
    // Each channel is a presence room; "typing" is simply being online in
    // it. The component schedules the timeout that clears an abandoned
    // composing session shortly after its keepalives stop.
    return await presence.heartbeat(
      ctx,
      channelId,
      userId,
      sessionId,
      interval,
    );
  },
});

export const whoIsTyping = query({
  args: {
    roomToken: v.string(),
  },
  handler: async (ctx, { roomToken }) => {
    // Reactive: entries flip to online:false on stop/timeout without any
    // wall-clock filtering, so subscriptions never serve stale indicators.
    return await presence.list(ctx, roomToken);
  },
});

export const stopTyping = mutation({
  args: {
    sessionToken: v.string(),
  },
  handler: async (ctx, { sessionToken }) => {
    return await presence.disconnect(ctx, sessionToken);
  },
});
