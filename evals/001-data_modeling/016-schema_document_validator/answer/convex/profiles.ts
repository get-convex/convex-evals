import { mutation } from "./_generated/server";
import schema from "./schema";

export const restoreProfile = mutation({
  args: { snapshot: schema.doc("profiles") },
  handler: async (ctx, args) => {
    const { _id, _creationTime, ...fields } = args.snapshot;
    const existing = await ctx.db.get("profiles", _id);
    if (existing === null) {
      throw new Error(`Profile ${_id} no longer exists`);
    }
    await ctx.db.replace("profiles", _id, fields);
    return null;
  },
});
