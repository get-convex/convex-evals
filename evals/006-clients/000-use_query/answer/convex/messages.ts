import { query } from "./_generated/server";
import { v } from "convex/values";

export const getAllMessages = query({
  args: {},
  handler: async (ctx) => {
    return ctx.db.query("messages").order("desc").collect();
  },
});