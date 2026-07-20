import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { createThread, listMessages, saveMessage } from "@convex-dev/agent";
import { components } from "./_generated/api";
import { mutation, query } from "./_generated/server";

export const createConversation = mutation({
  args: { userId: v.string(), title: v.string() },
  handler: async (ctx, args) => {
    return await createThread(ctx, components.agent, {
      userId: args.userId,
      title: args.title,
    });
  },
});

export const postUserMessage = mutation({
  args: { threadId: v.string(), text: v.string() },
  handler: async (ctx, args) => {
    await saveMessage(ctx, components.agent, {
      threadId: args.threadId,
      message: { role: "user", content: args.text },
    });
    return null;
  },
});

export const postAssistantMessage = mutation({
  args: { threadId: v.string(), text: v.string() },
  handler: async (ctx, args) => {
    await saveMessage(ctx, components.agent, {
      threadId: args.threadId,
      message: { role: "assistant", content: args.text },
    });
    return null;
  },
});

export const getConversation = query({
  args: { threadId: v.string(), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const result = await listMessages(ctx, components.agent, {
      threadId: args.threadId,
      paginationOpts: args.paginationOpts,
    });
    // The component paginates newest-first; the endpoint contract is
    // oldest-first within each page, so reverse the page.
    return {
      page: [...result.page].reverse().map((doc) => ({
        role: doc.message?.role ?? "user",
        content: doc.text ?? "",
      })),
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
  },
});
