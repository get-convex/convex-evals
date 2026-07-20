import { openai } from "@ai-sdk/openai";
import {
  Agent,
  createThread,
  listMessages,
  type MessageDoc,
} from "@convex-dev/agent";
import { v } from "convex/values";
import { components } from "./_generated/api";
import { action, mutation, query } from "./_generated/server";

const assistant = new Agent(components.agent, {
  name: "assistant",
  languageModel: openai.chat("gpt-4o-mini"),
  instructions: "You are a helpful, concise assistant.",
});

export const startConversation = mutation({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    return await createThread(ctx, components.agent, { userId: args.userId });
  },
});

export const sendMessage = action({
  args: { conversationId: v.string(), text: v.string() },
  handler: async (ctx, args) => {
    // Generating against the thread saves the user message and the reply,
    // and feeds the model the conversation's prior messages as context.
    const result = await assistant.generateText(
      ctx,
      { threadId: args.conversationId },
      { prompt: args.text },
    );
    return result.text;
  },
});

export const getHistory = query({
  args: { conversationId: v.string() },
  handler: async (ctx, args) => {
    // Page through the component until the whole history is read. Pages
    // come back newest-first, so the concatenation runs newest -> oldest;
    // reverse it for the oldest-first transcript.
    const docs: MessageDoc[] = [];
    let cursor: string | null = null;
    for (;;) {
      const result = await listMessages(ctx, components.agent, {
        threadId: args.conversationId,
        paginationOpts: { numItems: 200, cursor },
      });
      docs.push(...result.page);
      if (result.isDone) break;
      cursor = result.continueCursor;
    }
    return docs.reverse().map((doc) => ({
      role: doc.message?.role ?? "user",
      content: doc.text ?? "",
    }));
  },
});
