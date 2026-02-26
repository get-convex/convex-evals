import { mutation, internalMutation, action } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";

export const uploadFile = action({
  args: {
    contents: v.string(),
    fileName: v.string(),
  },
  handler: async (ctx, args): Promise<{
    fileId: Id<"files">;
    storageId: Id<"_storage">;
    url: string;
  }> => {
    const fileContents = new Blob([args.contents]);
    // Store the file in Convex Storage
    const storageId = await ctx.storage.store(fileContents);

    // Calculate file size in bytes
    const size = fileContents.size;

    // Store metadata and get the file ID
    const fileId = await ctx.runMutation(internal.index.storeFileMetadata, {
      storageId,
      fileName: args.fileName,
      size,
    });

    // Generate URL for file access
    const url = await ctx.storage.getUrl(storageId);
    if (!url) {
      throw new Error("Failed to generate URL for uploaded file");
    }

    return {
      fileId,
      storageId,
      url,
    };
  },
});

export const storeFileMetadata = internalMutation({
  args: {
    storageId: v.id("_storage"),
    fileName: v.string(),
    size: v.number(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("files", {
      storageId: args.storageId,
      fileName: args.fileName,
      size: args.size,
    });
  },
});