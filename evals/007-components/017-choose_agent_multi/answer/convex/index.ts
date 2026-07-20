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

const model = openai.chat("gpt-4o-mini");

const triageAgent = new Agent(components.agent, {
  name: "triage",
  languageModel: model,
  instructions:
    "You are the frontline support triage assistant. Answer general " +
    "questions and figure out what the customer needs.",
});

const billingAgent = new Agent(components.agent, {
  name: "billing-specialist",
  languageModel: model,
  instructions:
    "You are the billing specialist. Resolve invoicing, payment, and " +
    "refund issues using the conversation so far.",
});

export const openConversation = mutation({
  args: { userId: v.string() },
  handler: async (ctx, args) => {
    return await createThread(ctx, components.agent, { userId: args.userId });
  },
});

export const triage = action({
  args: { threadId: v.string(), text: v.string() },
  handler: async (ctx, args) => {
    const result = await triageAgent.generateText(
      ctx,
      { threadId: args.threadId },
      { prompt: args.text },
    );
    return result.text;
  },
});

export const escalateToBilling = action({
  args: { threadId: v.string() },
  handler: async (ctx, args) => {
    // Continue the SAME thread with the billing agent: it sees the whole
    // conversation so far. The handoff instruction is operational - not
    // part of the customer conversation - so it is not persisted; only the
    // billing specialist's reply is saved into the shared history.
    const { thread } = await billingAgent.continueThread(ctx, {
      threadId: args.threadId,
    });
    const result = await thread.generateText(
      {
        prompt:
          "You are taking over this conversation as the billing " +
          "specialist. Review the discussion so far and respond to the " +
          "customer's billing issue.",
      },
      { storageOptions: { saveMessages: "none" } },
    );
    await billingAgent.saveMessage(ctx, {
      threadId: args.threadId,
      message: { role: "assistant", content: result.text },
    });
    return result.text;
  },
});

export const getTranscript = query({
  args: { threadId: v.string() },
  handler: async (ctx, args) => {
    // Page through the component until the whole history is read. Pages
    // come back newest-first, so the concatenation runs newest -> oldest;
    // reverse it for the oldest-first transcript. agentName attributes
    // each assistant reply to the agent that wrote it.
    const docs: MessageDoc[] = [];
    let cursor: string | null = null;
    for (;;) {
      const result = await listMessages(ctx, components.agent, {
        threadId: args.threadId,
        paginationOpts: { numItems: 200, cursor },
      });
      docs.push(...result.page);
      if (result.isDone) break;
      cursor = result.continueCursor;
    }
    return docs.reverse().map((doc) => ({
      role: doc.message?.role ?? "user",
      content: doc.text ?? "",
      author: doc.agentName ?? null,
    }));
  },
});
