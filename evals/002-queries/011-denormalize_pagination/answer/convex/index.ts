import { query } from "./_generated/server";
import { v } from "convex/values";

/**
 * Paginates through dogs sorted by owner age.
 */
export const paginateDogsByOwnerAge = query({
  args: {
    cursor: v.union(v.string(), v.null()),
    numItems: v.number(),
  },
  handler: async (ctx, args) => {
    // Query dogs sorted by owner age
    const results = await ctx.db
      .query("dogs")
      .withIndex("by_owner_age")
      .paginate({cursor: args.cursor, numItems: args.numItems});

    // Format results and determine continue cursor
    return {
      dogs: results.page.map((dog) => ({
        name: dog.name,
        breed: dog.breed,
      })),
      continueCursor: results.continueCursor,
    };
  },
});

