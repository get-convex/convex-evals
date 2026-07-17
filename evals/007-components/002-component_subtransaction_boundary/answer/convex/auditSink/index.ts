import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

export const writeAudit = mutation({
  args: {
    event: v.string(),
    failAfterWrite: v.boolean(),
  },
  handler: async (ctx, args) => {
    // Insert first: proving the caller's catch rolls this back is the
    // point of the failAfterWrite path.
    await ctx.db.insert("audits", { event: args.event });
    if (args.failAfterWrite) {
      throw new Error("audit sink failure requested");
    }
    return null;
  },
});

export const countAudits = query({
  args: {
    event: v.string(),
  },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("audits")
      .withIndex("by_event", (q) => q.eq("event", args.event))
      .collect();
    return rows.length;
  },
});
