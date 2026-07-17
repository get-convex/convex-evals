import { v } from "convex/values";
import type { FunctionHandle } from "convex/server";
import { mutation } from "./_generated/server";

export const run = mutation({
  args: {
    handle: v.string(),
    jobKey: v.string(),
  },
  handler: async (ctx, args) => {
    // Handles cross the component boundary as strings and are cast back
    // to a typed FunctionHandle to be invoked.
    const callback = args.handle as FunctionHandle<
      "mutation",
      { jobKey: string },
      null
    >;
    await ctx.runMutation(callback, { jobKey: args.jobKey });
    return null;
  },
});
