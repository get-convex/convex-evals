import { v } from "convex/values";
import { internalMutation, mutation } from "./_generated/server";
import { components, internal } from "./_generated/api";
import { Workpool, vOnCompleteArgs } from "@convex-dev/workpool";

const pool = new Workpool(components.squaresPool, { maxParallelism: 2 });

export const submitJobs = mutation({
  args: {
    inputs: v.array(v.number()),
  },
  handler: async (ctx, args) => {
    for (const input of args.inputs) {
      await pool.enqueueMutation(
        ctx,
        internal.index.computeSquare,
        { input },
        {
          // The receipt is written by the completion callback, never here:
          // a job that throws could not record its own failure.
          onComplete: internal.index.recordReceipt,
          context: String(input),
        },
      );
    }
    return null;
  },
});

export const computeSquare = internalMutation({
  args: {
    input: v.number(),
  },
  handler: async (ctx, args) => {
    if (args.input === -1) {
      throw new Error("poisoned input: -1");
    }
    return args.input * args.input;
  },
});

export const recordReceipt = internalMutation({
  args: vOnCompleteArgs(v.string()),
  handler: async (ctx, args) => {
    await ctx.db.insert("receipts", {
      jobKey: args.context,
      kind: args.result.kind === "success" ? "success" : "failed",
      value:
        args.result.kind === "success"
          ? (args.result.returnValue as number)
          : null,
    });
  },
});
