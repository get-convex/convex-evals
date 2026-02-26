import { internalMutation, mutation } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";

/**
 * Get a document by ID and log the access asynchronously
 */
export const getDocument = mutation({
  args: { documentId: v.id("documents") },
  handler: async (ctx, args) => {
    const document = await ctx.db.get(args.documentId);

    if (!document) {
      throw new Error("Document not found");
    }

    // Schedule async logging
    await ctx.scheduler.runAfter(0, internal.index.logAccess, {
      documentId: args.documentId,
      action: "read",
    });

    return document;
  },
});

/**
 * Internal function to log document access
 */
export const logAccess = internalMutation({
  args: {
    documentId: v.id("documents"),
    action: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("accessLogs", {
      documentId: args.documentId,
      action: args.action,
    });
    return null;
  },
});