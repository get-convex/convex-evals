import { v } from "convex/values";
import { mutation } from "./_generated/server";

export const insertUser = mutation({
  args: v.object({
    email: v.string(),
    name: v.string(),
    age: v.number(),
  }),
  handler: async (ctx, args) => {
    return await ctx.db.insert("users", args);
  },
});
