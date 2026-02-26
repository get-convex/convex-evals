import { action } from "./_generated/server";
import { v } from "convex/values";

/**
 * Writes text content to Convex storage and returns the storage ID and URL.
 */
export const writeTextToStorage = action({
  args: {
    text: v.string(),
  },
  handler: async (ctx, args) => {
    // Store the text as a blob
    const storageId = await ctx.storage.store(new Blob([args.text], {
      type: "text/plain",
    }));

    // Get the URL for the stored file
    const url = await ctx.storage.getUrl(storageId);
    if (!url) {
      throw new Error("Failed to generate URL for stored file");
    }

    return {
      storageId,
      url,
    };
  },
});

/**
 * Reads text content from Convex storage by storage ID.
 */
export const readTextFromStorage = action({
  args: {
    storageId: v.id("_storage"),
  },
  handler: async (ctx, args) => {
    // Get the blob from storage
    const blob = await ctx.storage.get(args.storageId);
    if (!blob) {
      throw new Error("File not found in storage");
    }

    // Convert binary data back to text
    const text = await blob.text();

    return text;
  },
});