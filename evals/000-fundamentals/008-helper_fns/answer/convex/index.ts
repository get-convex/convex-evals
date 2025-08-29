import { query, mutation, QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import { Doc, Id } from "./_generated/dataModel";

// Define the return type for our formatted item data
type FormattedItemData = {
  name: string;
  quantity: number;
  lastModified: string;
};

// Shared helper function to get and format item data
async function getItemData(
  ctx: QueryCtx,
  itemId: Id<"items">,
): Promise<FormattedItemData | null> {
  const item = await ctx.db.get(itemId);
  if (!item) {
    return null;
  }

  return {
    name: item.name,
    quantity: item.quantity,
    lastModified: new Date(item.lastModified).toISOString(),
  };
}

// Query to get an item by ID
export const getItem = query({
  args: { itemId: v.id("items") },
  returns: v.object({
    name: v.string(),
    quantity: v.number(),
    lastModified: v.string(),
  }),
  handler: async (ctx, args) => {
    const formattedItem = await getItemData(ctx, args.itemId);

    if (!formattedItem) {
      throw new Error(`Item with ID ${args.itemId} not found`);
    }

    return formattedItem;
  },
});

// Mutation to update an item's quantity
export const updateItem = mutation({
  args: {
    itemId: v.id("items"),
    quantity: v.number(),
  },
  returns: v.object({
    name: v.string(),
    quantity: v.number(),
    lastModified: v.string(),
  }),
  handler: async (ctx, args) => {
    await ctx.db.patch(args.itemId, {
      quantity: args.quantity,
      lastModified: Date.now(),
    });

    const formattedItem = await getItemData(ctx, args.itemId);

    if (!formattedItem) {
      throw new Error(`Item with ID ${args.itemId} not found`);
    }

    return formattedItem;
  },
});
