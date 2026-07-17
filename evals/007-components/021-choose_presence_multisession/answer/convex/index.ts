import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { components } from "./_generated/api";
import { Presence } from "@convex-dev/presence";

const presence = new Presence(components.presence);

export const sessionHeartbeat = mutation({
  args: {
    roomId: v.string(),
    userId: v.string(),
    sessionId: v.string(),
    interval: v.number(),
  },
  handler: async (ctx, { roomId, userId, sessionId, interval }) => {
    // The component aggregates all of a user's sessions into one presence
    // entry and schedules per-session timeouts, so the show-once /
    // online-while-any-session-lives semantics hold under concurrency.
    return await presence.heartbeat(ctx, roomId, userId, sessionId, interval);
  },
});

export const listParticipants = query({
  args: {
    roomToken: v.string(),
  },
  handler: async (ctx, { roomToken }) => {
    // One aggregated entry per user; a user flips to online:false only
    // after their LAST session disconnects or times out.
    return await presence.list(ctx, roomToken);
  },
});

export const leaveSession = mutation({
  args: {
    sessionToken: v.string(),
  },
  handler: async (ctx, { sessionToken }) => {
    return await presence.disconnect(ctx, sessionToken);
  },
});
