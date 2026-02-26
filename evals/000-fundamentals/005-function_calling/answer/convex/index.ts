import { v } from "convex/values";
import {
  mutation,
  action,
  internalQuery,
  internalMutation,
  internalAction,
} from "./_generated/server";
import { internal } from "./_generated/api";

export const calleeQuery = internalQuery({
  args: { x: v.number(), y: v.number() },
  handler: async (ctx, args) => {
    return args.x + args.y;
  },
});

export const calleeMutation = internalMutation({
  args: { x: v.number(), y: v.number() },
  handler: async (ctx, args) => {
    return args.x - args.y;
  },
});

export const calleeAction = internalAction({
  args: { x: v.number(), y: v.number() },
  handler: async (ctx, args) => {
    return args.x * args.y;
  },
});

export const callerMutation = mutation({
  args: {},
  handler: async (ctx, args) => {
    const r1: number = await ctx.runQuery(internal.index.calleeQuery, {
      x: 1,
      y: 2,
    });
    const r2: number = await ctx.runMutation(internal.index.calleeMutation, {
      x: r1,
      y: 2,
    });
    return r2;
  },
});

export const callerAction = action({
  args: {},
  handler: async (ctx, args) => {
    const r1: number = await ctx.runQuery(internal.index.calleeQuery, {
      x: 1,
      y: 2,
    });
    const r2: number = await ctx.runMutation(internal.index.calleeMutation, {
      x: r1,
      y: 2,
    });
    const r3: number = await ctx.runAction(internal.index.calleeAction, {
      x: r2,
      y: 2,
    });
    return r3;
  },
});
