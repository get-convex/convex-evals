import { action } from "./_generated/server";
import { v } from "convex/values";

/**
 * Demonstrates making an external HTTP request to httpbin.org
 * Returns the parsed JSON response from the service.
 */
export const fetchFromHttpBin = action({
  args: {},
  handler: async (ctx) => {
    const response = await fetch("https://httpbin.org/get");
    const data = await response.json();
    return data;
  },
});