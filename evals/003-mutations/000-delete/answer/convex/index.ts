import { v } from "convex/values";
import { mutation } from "./_generated/server";

export const deleteUserById = mutation({
  args: { id: v.id("users") },
  handler: async (ctx, args) => {
    await ctx.db.delete("users", args.id);
    return null;
  },
});
