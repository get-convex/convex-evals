import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const create = mutation({
  args: {
    name: v.string(),
    email: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("contacts", {
      name: args.name,
      email: args.email,
      archived: false,
    });
  },
});

export const get = query({
  args: {
    id: v.id("contacts"),
  },
  handler: async (ctx, args) => {
    return await ctx.db.get("contacts", args.id);
  },
});

export const rename = mutation({
  args: {
    id: v.id("contacts"),
    name: v.string(),
  },
  handler: async (ctx, args) => {
    const contact = await ctx.db.get("contacts", args.id);
    if (!contact) {
      throw new Error("Contact not found");
    }

    await ctx.db.patch("contacts", args.id, {
      name: args.name,
    });
  },
});

export const replaceContact = mutation({
  args: {
    id: v.id("contacts"),
    name: v.string(),
    email: v.string(),
    archived: v.boolean(),
  },
  handler: async (ctx, args) => {
    const contact = await ctx.db.get("contacts", args.id);
    if (!contact) {
      throw new Error("Contact not found");
    }

    await ctx.db.replace("contacts", args.id, {
      name: args.name,
      email: args.email,
      archived: args.archived,
    });
  },
});

export const remove = mutation({
  args: {
    id: v.id("contacts"),
  },
  handler: async (ctx, args) => {
    const contact = await ctx.db.get("contacts", args.id);
    if (!contact) {
      return false;
    }

    await ctx.db.delete("contacts", args.id);
    return true;
  },
});
