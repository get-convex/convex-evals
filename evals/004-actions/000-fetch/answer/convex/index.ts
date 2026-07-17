import { action } from "./_generated/server";
import { v } from "convex/values";

/**
 * Demonstrates making an external HTTP request and returning parsed JSON.
 */
export const fetchJson = action({
  args: { url: v.string() },
  handler: async (_ctx, args) => {
    const response = await fetch(args.url);
    const data = await response.json();
    return data;
  },
});
