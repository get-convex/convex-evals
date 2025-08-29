import { query } from "./_generated/server";
import { v } from "convex/values";

/**
 * Get a post by ID, returning the raw document.
 */
export const getPost = query({
  args: { postId: v.id("posts") },
  // Return type validator matches the document type exactly
  returns: v.object({
    _id: v.id("posts"),
    _creationTime: v.number(),
    title: v.string(),
    content: v.string(),
    authorId: v.id("users"),
  }),
  handler: async (ctx, args) => {
    const post = await ctx.db.get(args.postId);
    if (!post) {
      throw new Error("Post not found");
    }
    return post;
  },
});

/**
 * Get a post with a status indicator, demonstrating discriminated union returns.
 */
export const getPostWithStatus = query({
  args: { postId: v.id("posts") },
  // Union type validator for success/error states
  returns: v.union(
    v.object({
      success: v.literal(true),
      post: v.object({
        _id: v.id("posts"),
        _creationTime: v.number(),
        title: v.string(),
        content: v.string(),
        authorId: v.id("users"),
      }),
    }),
    v.object({
      success: v.literal(false),
      error: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    const post = await ctx.db.get(args.postId);

    if (!post) {
      return {
        success: false,
        error: "Post not found",
      } as const;
    }

    if (post.title === "") {
      return {
        success: false,
        error: "Post title cannot be empty",
      } as const;
    }

    return {
      success: true,
      post,
    } as const;
  },
});

/**
 * Get a post with its author, demonstrating tuple returns.
 */
export const getPostWithAuthor = query({
  args: { postId: v.id("posts") },
  // Tuple type validator for post and author
  returns: v.array(
    v.union(
      v.object({
        _id: v.id("users"),
        _creationTime: v.number(),
        name: v.string(),
        email: v.string(),
      }),
      v.object({
        _id: v.id("posts"),
        _creationTime: v.number(),
        title: v.string(),
        content: v.string(),
        authorId: v.id("users"),
      }),
    ),
  ),
  handler: async (ctx, args) => {
    const post = await ctx.db.get(args.postId);
    if (!post) {
      throw new Error("Post not found");
    }

    const author = await ctx.db.get(post.authorId);
    if (!author) {
      throw new Error("Author not found");
    }

    return [author, post];
  },
});
