import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";

// Validator for the author object structure
const authorValidator = v.object({
  name: v.string(),
  contact: v.object({
    email: v.string(),
    phone: v.optional(v.string()),
  }),
});

// Validator for the metadata object structure
const metadataValidator = v.object({
  title: v.string(),
  author: authorValidator,
  tags: v.array(v.string()),
});


export const createDocument = mutation({
  args: schema.tables.documents.validator.fields,
  handler: async (ctx, args) => {
    return await ctx.db.insert("documents", args);
  },
});

export const patchDocumentMetadata = mutation({
  args: {
    documentId: v.id("documents"),
    metadata: schema.tables.documents.validator.fields.metadata,
  },
  handler: async (ctx, args) => {
    const document = await ctx.db.get(args.documentId);
    if (!document) {
      throw new Error(`Document ${args.documentId} not found`);
    }

    await ctx.db.patch(args.documentId, {
      metadata: args.metadata,
    });
    return null;
  },
});

export const patchAuthorInfo = mutation({
  args: {
    documentId: v.id("documents"),
    author: schema.tables.documents.validator.fields.metadata.fields.author,
  },
  handler: async (ctx, args) => {
    const document = await ctx.db.get(args.documentId);
    if (!document) {
      throw new Error(`Document ${args.documentId} not found`);
    }

    await ctx.db.patch(args.documentId, {
      metadata: {
        ...document.metadata,
        author: args.author,
      },
    });
    return null;
  },
});

export const getDocument = query({
  args: {
    documentId: v.id("documents"),
  },
  handler: async (ctx, args) => {
    const document = await ctx.db.get(args.documentId);
    return document;
  },
});