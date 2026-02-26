import { v } from "convex/values";
import { mutation } from "./_generated/server";

export const updateUserEmail = mutation({
  args: v.object({
    id: v.id("users"),
    email: v.string(),
  }),
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.id);
    if (user == null) {
      throw new Error("User not found");
    }
    await ctx.db.patch(args.id, { email: args.email });
    return null;
  },
});
