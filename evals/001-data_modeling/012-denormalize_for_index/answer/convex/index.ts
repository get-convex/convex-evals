import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { Id } from "./_generated/dataModel";

/**
 * Creates a new dog record with denormalized owner data.
 */
export const createDog = mutation({
  args: {
    dogName: v.string(),
    breed: v.string(),
    ownerId: v.id("owners"),
  },
  handler: async (ctx, args) => {
    // Fetch owner to ensure they exist and get their age
    const owner = await ctx.db.get(args.ownerId);
    if (!owner) {
      throw new Error("Owner not found");
    }

    // Create dog record with denormalized owner age
    const dogId = await ctx.db.insert("dogs", {
      name: args.dogName,
      breed: args.breed,
      ownerId: args.ownerId,
      ownerAge: owner.age,
    });

    return dogId;
  },
});

/**
 * Updates an owner's age and maintains consistency in denormalized data.
 */
export const updateOwnerAge = mutation({
  args: {
    ownerId: v.id("owners"),
    newAge: v.number(),
  },
  handler: async (ctx, args) => {
    // Check if owner exists
    const owner = await ctx.db.get(args.ownerId);
    if (!owner) {
      throw new Error("Owner not found");
    }

    // Update owner's age
    await ctx.db.patch(args.ownerId, { age: args.newAge });

    // Update all dogs owned by this owner
    const dogsToUpdate = await ctx.db
      .query("dogs")
      .withIndex("by_owner", (q) => q.eq("ownerId", args.ownerId))
      .collect();

    // Update each dog's denormalized owner age
    for (const dog of dogsToUpdate) {
      await ctx.db.patch(dog._id, { ownerAge: args.newAge });
    }

    return null;
  },
});

export const getDogsByOwnerAge = query({
  args: {
    age: v.number(),
  },
  handler: async (ctx, args) => {
    const dogs =  await ctx.db
      .query("dogs")
      .withIndex("by_owner_age", (q) => q.eq("ownerAge", args.age))
      .collect();
    return dogs.map(d => ({ name: d.name, breed: d.breed }));
  },
});
