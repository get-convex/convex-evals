import { expect, test } from "vitest";
import {
  responseAdminClient,
  responseClient,
  compareSchema,
  addDocuments,
  listTable,
  deleteAllDocuments,
} from "../../../grader";
import { api } from "./answer/convex/_generated/api";
import { Doc } from "./answer/convex/_generated/dataModel";
import { beforeEach } from "vitest";
import { PaginationResult } from "convex/server";

beforeEach(async () => {
  await deleteAllDocuments(responseAdminClient, ["messages", "channels"]);
});

test("compare schema", async ({ skip }) => {
  await compareSchema(skip);
});

test("paginateChannelMessages returns empty result for non-existent channel", async () => {
  // Create a channel first
  await addDocuments(responseAdminClient, "channels", [
    { name: "Test Channel" },
  ]);
  const channel = (
    await listTable(responseAdminClient, "channels")
  )[0] as Doc<"channels">;

  const result = await responseClient.query(api.index.paginateChannelMessages, {
    channelId: channel._id,
    paginationOpts: { numItems: 10, cursor: null },
  });

  expect(result.page).toEqual([]);
  expect(result.isDone).toBe(true);
});

test("paginateChannelMessages returns messages in correct order", async () => {
  // Create a channel
  await addDocuments(responseAdminClient, "channels", [
    { name: "Test Channel" },
  ]);
  const channel = (
    await listTable(responseAdminClient, "channels")
  )[0] as Doc<"channels">;

  // Add messages
  const messages = [
    { channelId: channel._id, content: "First Message", author: "User1" },
    { channelId: channel._id, content: "Second Message", author: "User2" },
    { channelId: channel._id, content: "Third Message", author: "User1" },
  ];
  await addDocuments(responseAdminClient, "messages", messages);

  const result = await responseClient.query(api.index.paginateChannelMessages, {
    channelId: channel._id,
    paginationOpts: { numItems: 10, cursor: null },
  });

  // Messages should be in reverse chronological order
  expect(result.page.map((m) => m.content)).toEqual([
    "Third Message",
    "Second Message",
    "First Message",
  ]);
});

test("paginateChannelMessages respects pagination size", async () => {
  // Create a channel
  await addDocuments(responseAdminClient, "channels", [
    { name: "Test Channel" },
  ]);
  const channel = (
    await listTable(responseAdminClient, "channels")
  )[0] as Doc<"channels">;

  // Add several messages
  const messages = Array.from({ length: 5 }, (_, i) => ({
    channelId: channel._id,
    content: `Message ${i + 1}`,
    author: "User1",
  }));
  await addDocuments(responseAdminClient, "messages", messages);

  // Request first page
  const firstPage = await responseClient.query(
    api.index.paginateChannelMessages,
    {
      channelId: channel._id,
      paginationOpts: { numItems: 2, cursor: null },
    },
  );

  expect(firstPage.page).toHaveLength(2);
  expect(firstPage.isDone).toBe(false);

  // Request second page
  const secondPage = await responseClient.query(
    api.index.paginateChannelMessages,
    {
      channelId: channel._id,
      paginationOpts: { numItems: 2, cursor: firstPage.continueCursor },
    },
  );

  expect(secondPage.page).toHaveLength(2);
  expect(secondPage.isDone).toBe(false);

  // Request final page
  const finalPage = await responseClient.query(
    api.index.paginateChannelMessages,
    {
      channelId: channel._id,
      paginationOpts: { numItems: 2, cursor: secondPage.continueCursor },
    },
  );

  expect(finalPage.page).toHaveLength(1);
  expect(finalPage.isDone).toBe(true);
});

test("paginateChannelMessages only returns messages from specified channel", async () => {
  // Create two channels
  await addDocuments(responseAdminClient, "channels", [
    { name: "Channel 1" },
    { name: "Channel 2" },
  ]);
  const channels = (await listTable(
    responseAdminClient,
    "channels",
  )) as Doc<"channels">[];
  const [channel1, channel2] = channels.slice(-2);

  // Add messages to both channels
  await addDocuments(responseAdminClient, "messages", [
    { channelId: channel1._id, content: "Channel 1 Message", author: "User1" },
    { channelId: channel2._id, content: "Channel 2 Message", author: "User1" },
  ]);

  // Query messages from channel 1
  const channel1Messages = await responseClient.query(
    api.index.paginateChannelMessages,
    {
      channelId: channel1._id,
      paginationOpts: { numItems: 10, cursor: null },
    },
  );

  expect(channel1Messages.page).toHaveLength(1);
  expect(channel1Messages.page[0].content).toBe("Channel 1 Message");

  // Query messages from channel 2
  const channel2Messages = await responseClient.query(
    api.index.paginateChannelMessages,
    {
      channelId: channel2._id,
      paginationOpts: { numItems: 10, cursor: null },
    },
  );

  expect(channel2Messages.page).toHaveLength(1);
  expect(channel2Messages.page[0].content).toBe("Channel 2 Message");
});

test("paginateChannelMessages returns all message fields", async () => {
  // Create a channel
  await addDocuments(responseAdminClient, "channels", [
    { name: "Test Channel" },
  ]);
  const channel = (
    await listTable(responseAdminClient, "channels")
  )[0] as Doc<"channels">;

  // Add a message with all fields
  const message = {
    channelId: channel._id,
    content: "Test Message",
    author: "Test Author",
  };
  await addDocuments(responseAdminClient, "messages", [message]);

  const result = await responseClient.query(api.index.paginateChannelMessages, {
    channelId: channel._id,
    paginationOpts: { numItems: 1, cursor: null },
  });

  expect(result.page[0]).toMatchObject(message);
});

test("paginateChannelMessages maintains consistent ordering across pages", async () => {
  // Create a channel
  await addDocuments(responseAdminClient, "channels", [
    { name: "Test Channel" },
  ]);
  const channel = (
    await listTable(responseAdminClient, "channels")
  )[0] as Doc<"channels">;

  // Add messages with known order
  const messages = Array.from({ length: 10 }, (_, i) => ({
    channelId: channel._id,
    content: `Message ${10 - i}`,
    author: "User1",
  }));
  await addDocuments(responseAdminClient, "messages", messages);

  // Collect all messages through pagination
  const allMessages = [];
  let cursor = null;
  let isDone = false;

  while (!isDone) {
    const result: PaginationResult<Doc<"messages">> =
      await responseClient.query(api.index.paginateChannelMessages, {
        channelId: channel._id,
        paginationOpts: { numItems: 3, cursor },
      });

    allMessages.push(...result.page);
    cursor = result.continueCursor;
    isDone = result.isDone;
  }

  // Verify ordering
  const expectedMessages = [...messages].reverse().map((m) => m.content);
  expect(allMessages.map((m) => m.content)).toEqual(expectedMessages);
});
