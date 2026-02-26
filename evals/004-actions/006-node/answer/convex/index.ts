"use node";
import { action } from "./_generated/server";
import { v } from "convex/values";
import crypto from "crypto";
import path from "path";

// Define the action using Node runtime
export const processWithNode = action({
  args: { data: v.string() },
  handler: async (ctx, args) => {
    // Specify Node runtime to access Node.js built-in modules


      // Generate SHA-256 hash of input string
      const hash = crypto
        .createHash("sha256")
        .update(args.data)
        .digest("hex");

      // Normalize a test path
      const normalizedPath = path.normalize("/some/test/path");

      return {
        hash,
        normalizedPath,
      };
  },
});