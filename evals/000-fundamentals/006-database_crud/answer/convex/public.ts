import { v } from "convex/values";
import { query, mutation, internalQuery } from "./_generated/server";

export const createLocation = mutation({
  args: {
    name: v.string(),
    latitude: v.number(),
    longitude: v.number(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("locations", args);
  },
});

export const readLocation = query({
  args: {
    id: v.id("locations"),
  },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

export const updateLocation = mutation({
  args: {
    id: v.id("locations"),
    name: v.string(),
    latitude: v.number(),
    longitude: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.id);
    if (!existing) {
      throw new Error("Location not found");
    }
    await ctx.db.replace(args.id, {
      name: args.name,
      latitude: args.latitude,
      longitude: args.longitude,
    });
  },
});

export const patchLocation = mutation({
  args: {
    id: v.id("locations"),
    name: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, {
      name: args.name,
    });
  },
});

export const deleteLocation = mutation({
  args: {
    id: v.id("locations"),
  },
  handler: async (ctx, args) => {
    await ctx.db.delete(args.id);
  },
});
