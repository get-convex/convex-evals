import { internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";

// Check if an asset with this hash already exists
export const getByHash = internalQuery({
  args: {
    hash: v.string(),
  },
  returns: v.union(
    v.object({
      storageId: v.id("_storage"),
      hash: v.string(),
    }),
    v.null()
  ),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("evalAssets")
      .withIndex("by_hash", (q) => q.eq("hash", args.hash))
      .first();
    
    if (!existing) return null;
    
    return {
      storageId: existing.storageId,
      hash: existing.hash,
    };
  },
});

// Create a new asset record
export const create = internalMutation({
  args: {
    hash: v.string(),
    assetType: v.union(v.literal("evalSource"), v.literal("output")),
    storageId: v.id("_storage"),
  },
  returns: v.id("evalAssets"),
  handler: async (ctx, args) => {
    // Double-check it doesn't already exist
    const existing = await ctx.db
      .query("evalAssets")
      .withIndex("by_hash", (q) => q.eq("hash", args.hash))
      .first();
    
    if (existing) {
      return existing._id;
    }
    
    return await ctx.db.insert("evalAssets", {
      hash: args.hash,
      assetType: args.assetType,
      storageId: args.storageId,
    });
  },
});
