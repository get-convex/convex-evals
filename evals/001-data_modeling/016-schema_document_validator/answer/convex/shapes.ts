import { mutation, query } from "./_generated/server";
import schema from "./schema";

export const getShape = query({
  args: { shapeId: schema.id("shapes") },
  handler: async (ctx, args) => {
    return await ctx.db.get("shapes", args.shapeId);
  },
});

export const restoreShape = mutation({
  // The whole-document validator is derived from the schema: every union
  // member gains `_id` and `_creationTime`, so nothing is written twice.
  args: { snapshot: schema.doc("shapes") },
  handler: async (ctx, args) => {
    const { _id, _creationTime, ...fields } = args.snapshot;
    const existing = await ctx.db.get("shapes", _id);
    if (existing === null) {
      throw new Error(`Shape ${_id} no longer exists`);
    }
    await ctx.db.replace("shapes", _id, fields);
    return null;
  },
});
