import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { Doc, Id } from "./_generated/dataModel";

// Helper function to migrate a product's data structure
function migrateProductHelper(product: Doc<"products">): {
  _id: Id<"products">,
  _creationTime: number,
  name: string,
  description: string,
  category: undefined,
  active: "active" | "inactive" | "banned"
} {
  return {
    ...product,
    description: product.description || "No description",
    category: undefined,
    active: product.active ? "active" : "inactive",
  };
}

/**
 * Migrate a single product to the new schema
 */
export const migrateProduct = mutation({
  args: {
    productId: v.id("products"),
  },
  handler: async (ctx, args) => {
    const product = await ctx.db.get(args.productId);
    if (!product) {
      throw new Error("Product not found");
    }

    const updates = migrateProductHelper(product);
    await ctx.db.patch(product._id, updates);
  },
});

/**
 * Get a product
 */
export const getProduct = query({
  args: {
    productId: v.id("products"),
  },
  handler: async (ctx, args) => {
    const product = await ctx.db.get(args.productId);
    if (!product) {
      throw new Error("Product not found");
    }
    return migrateProductHelper(product);
  },
});