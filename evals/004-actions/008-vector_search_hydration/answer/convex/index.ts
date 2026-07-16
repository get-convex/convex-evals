import { v } from "convex/values";
import { action, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc } from "./_generated/dataModel";

export const searchDocuments = action({
  args: {
    embedding: v.array(v.float64()),
    category: v.string(),
    limit: v.number(),
  },
  handler: async (ctx, args) => {
    // The vector filter only supports equality on filterFields, so the
    // category is pushed down here and the status check happens after
    // hydration.
    const hits = await ctx.vectorSearch("documents", "by_embedding", {
      vector: args.embedding,
      limit: args.limit,
      filter: (q) => q.eq("category", args.category),
    });

    const docs: (Doc<"documents"> | null)[] = await ctx.runQuery(
      internal.index.fetchDocuments,
      { ids: hits.map((hit) => hit._id) },
    );

    const results = [];
    for (let i = 0; i < hits.length; i++) {
      const doc = docs[i];
      if (doc === null || doc.status !== "published") {
        continue;
      }
      results.push({
        _id: doc._id,
        title: doc.title,
        category: doc.category,
        status: doc.status,
        _score: hits[i]._score,
      });
    }
    return results;
  },
});

export const fetchDocuments = internalQuery({
  args: {
    ids: v.array(v.id("documents")),
  },
  handler: async (ctx, args) => {
    return await Promise.all(
      args.ids.map((id) => ctx.db.get("documents", id)),
    );
  },
});
