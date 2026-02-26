import { v } from "convex/values";
import {
  mutation,
  action,
  internalMutation,
  internalAction,
} from "./_generated/server";
import { internal } from "./_generated/api";

export const logMutation = internalMutation({
  args: { message: v.string() },
  handler: async (ctx, args) => {
    console.log(args.message);
  },
});

export const logAction = internalAction({
  args: { message: v.string() },
  handler: async (ctx, args) => {
    console.log(args.message);
  },
});

export const callerMutation = mutation({
  args: {},
  handler: async (ctx, args) => {
    const schedulerId = await ctx.scheduler.runAfter(
      0,
      internal.index.logMutation,
      { message: "Hello, world!" },
    );
    await ctx.scheduler.cancel(schedulerId);

    await ctx.scheduler.runAt(Date.now() + 10000, internal.index.logAction, {
      message: "Hello, world!",
    });
  },
});

export const callerAction = action({
  args: {},
  handler: async (ctx, args) => {
    await ctx.scheduler.runAfter(
      Math.random() * 10000,
      internal.index.logAction,
      { message: "Hello, world!" },
    );
    const schedulerId = await ctx.scheduler.runAt(
      Date.now(),
      internal.index.logMutation,
      { message: "Hello, world!" },
    );
    await ctx.scheduler.cancel(schedulerId);
  },
});
