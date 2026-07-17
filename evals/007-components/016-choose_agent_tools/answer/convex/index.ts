import { openai } from "@ai-sdk/openai";
import {
  Agent,
  createThread,
  createTool,
  stepCountIs,
} from "@convex-dev/agent";
import { v } from "convex/values";
import { z } from "zod";
import { api, components } from "./_generated/api";
import { action, mutation, query } from "./_generated/server";

export const getInventoryCount = query({
  args: { productName: v.string() },
  handler: async (ctx, args) => {
    const product = await ctx.db
      .query("products")
      .withIndex("by_name", (q) => q.eq("name", args.productName))
      .unique();
    return product === null ? null : product.stock;
  },
});

export const getOrderStatus = query({
  args: { orderNumber: v.string() },
  handler: async (ctx, args) => {
    const order = await ctx.db
      .query("orders")
      .withIndex("by_orderNumber", (q) => q.eq("orderNumber", args.orderNumber))
      .unique();
    return order === null ? null : order.status;
  },
});

const lookupInventory = createTool({
  description: "Get the current stock count for a product by its exact name.",
  inputSchema: z.object({ productName: z.string() }),
  execute: async (ctx, input): Promise<number | null> => {
    return await ctx.runQuery(api.index.getInventoryCount, {
      productName: input.productName,
    });
  },
});

const lookupOrderStatus = createTool({
  description: "Get the current status of an order by its order number.",
  inputSchema: z.object({ orderNumber: z.string() }),
  execute: async (ctx, input): Promise<string | null> => {
    return await ctx.runQuery(api.index.getOrderStatus, {
      orderNumber: input.orderNumber,
    });
  },
});

const assistant = new Agent(components.agent, {
  name: "operations-assistant",
  languageModel: openai.chat("gpt-4o-mini"),
  instructions:
    "You answer questions about inventory and orders. Always fetch live " +
    "values with the provided tools; never guess stock counts or order " +
    "statuses.",
  tools: { lookupInventory, lookupOrderStatus },
  stopWhen: stepCountIs(5),
});

export const openThread = mutation({
  args: {},
  handler: async (ctx) => {
    return await createThread(ctx, components.agent);
  },
});

export const askAssistant = action({
  args: { threadId: v.string(), question: v.string() },
  handler: async (ctx, args) => {
    // Thread-scoped generation records the question, every tool step and
    // its result, and the final reply in the conversation's history.
    const result = await assistant.generateText(
      ctx,
      { threadId: args.threadId },
      { prompt: args.question },
    );
    return result.text;
  },
});
