import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  mutation,
} from "./_generated/server";
import { components, internal } from "./_generated/api";
import { Workpool } from "@convex-dev/workpool";

// One pool for all accounting syncs: at most 3 actions run at once
// platform-wide, and failed actions retry with exponential backoff. The
// accounting API is idempotent per exportKey, so retries are safe.
const syncPool = new Workpool(components.workpool, {
  maxParallelism: 3,
  retryActionsByDefault: true,
  defaultRetryBehavior: { maxAttempts: 5, initialBackoffMs: 500, base: 2 },
});

export const createOrderExport = mutation({
  args: {
    exportKey: v.string(),
  },
  handler: async (ctx, args) => {
    const exportId = await ctx.db.insert("orderExports", {
      exportKey: args.exportKey,
      status: "pending",
    });
    await syncPool.enqueueAction(ctx, internal.index.syncExport, {
      exportId,
      exportKey: args.exportKey,
    });
    return exportId;
  },
});

export const syncExport = internalAction({
  args: {
    exportId: v.id("orderExports"),
    exportKey: v.string(),
  },
  handler: async (ctx, args) => {
    const response = await fetch("https://accounting.example.com/api/exports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ exportKey: args.exportKey }),
    });
    if (!response.ok) {
      throw new Error(`Accounting API rejected export: ${response.status}`);
    }
    await ctx.runMutation(internal.index.markSynced, {
      exportId: args.exportId,
    });
  },
});

export const markSynced = internalMutation({
  args: {
    exportId: v.id("orderExports"),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch("orderExports", args.exportId, { status: "synced" });
  },
});
