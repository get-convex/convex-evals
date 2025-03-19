import { internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";

/**
 * Create a new authentication token with a given name.
 * The token value is automatically generated.
 */
export const createToken = internalMutation({
  args: {
    name: v.string(),
  },
  returns: v.object({
    tokenId: v.id("authTokens"),
    name: v.string(),
    value: v.string(),
  }),
  handler: async (ctx, args) => {
    // Check if a token with this name already exists
    const existingToken = await ctx.db
      .query("authTokens")
      .withIndex("by_name", (q) => q.eq("name", args.name))
      .unique();

    if (existingToken) {
      throw new Error(`A token with the name "${args.name}" already exists.`);
    }

    // Generate a new token value (UUID)
    const value = crypto.randomUUID();

    // Store the token in the database
    const tokenId = await ctx.db.insert("authTokens", {
      name: args.name,
      value,
      createdAt: Date.now(),
    });

    return {
      tokenId,
      name: args.name,
      value,
    };
  },
});

/**
 * Validate if a token exists and update its lastUsed timestamp.
 * This is an internal function used by HTTP endpoints.
 */
export const validateToken = internalMutation({
  args: {
    value: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    // Look up the token by its value
    const token = await ctx.db
      .query("authTokens")
      .withIndex("by_value", (q) => q.eq("value", args.value))
      .unique();

    if (!token) {
      return false;
    }

    // Update the lastUsed timestamp
    await ctx.db.patch(token._id, {
      lastUsed: Date.now(),
    });

    return true;
  },
});

/**
 * List all tokens (names only, not the values).
 */
export const listTokens = internalQuery({
  args: {},
  returns: v.array(
    v.object({
      _id: v.id("authTokens"),
      name: v.string(),
      createdAt: v.number(),
      lastUsed: v.optional(v.number()),
    }),
  ),
  handler: async (ctx) => {
    const tokens = await ctx.db.query("authTokens").collect();

    // Return tokens without exposing their values
    return tokens.map((token) => ({
      _id: token._id,
      name: token.name,
      createdAt: token.createdAt,
      lastUsed: token.lastUsed,
    }));
  },
});

/**
 * Delete a token by ID.
 */
export const deleteToken = internalMutation({
  args: {
    tokenId: v.id("authTokens"),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const token = await ctx.db.get(args.tokenId);

    if (!token) {
      return false;
    }

    await ctx.db.delete(args.tokenId);
    return true;
  },
});
