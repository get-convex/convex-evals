import { paginationOptsValidator } from "convex/server";
import { query } from "./_generated/server";

export const paginateMessagesWithAuthors = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    // Fetch paginated messages
    const messagesPage = await ctx.db
      .query("messages")
      .order("desc")
      .paginate(args.paginationOpts);


    // Combine message data with author data
    const messagesWithAuthors = await Promise.all(messagesPage.page.map(async (message) => {
      const author = await ctx.db.get("users", message.authorId);
      if (!author) {
        throw new Error("Author not found");
      }
      return {
        ...message,
        author: author.name,
      };
    }));

    // Return in format expected by usePaginatedQuery
    return {
      ...messagesPage,
      page: messagesWithAuthors,
    };
  },
});