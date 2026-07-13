import { query } from "./_generated/server";
import { v } from "convex/values";
import {
  paginationOptsValidator,
  paginationResultValidator,
} from "convex/server";

/**
 * Paginated query for posts that's compatible with usePaginatedQuery.
 * Returns posts in default order (ascending _creationTime) with proper cursor handling.
 */
export const paginatePosts = query({
  args: {
    paginationOpts: paginationOptsValidator,
  },
  // Properly typed return validator matching usePaginatedQuery expectations
  returns: paginationResultValidator(
    v.object({
      _id: v.id("posts"),
      _creationTime: v.number(),
      title: v.string(),
      content: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    // Query posts with pagination
    const posts = await ctx.db
      .query("posts")
      .paginate(args.paginationOpts);

    return posts;
  },
});
