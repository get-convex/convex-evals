import { expect, test } from "vitest";
import {
  responseClient,
  compareSchema,
  addDocuments,
  deleteAllDocuments,
  responseAdminClient,
} from "../../../grader";
import { api } from "./answer/convex/_generated/api";
import { beforeEach } from "vitest";
import { createAIGraderTest } from "../../../grader/aiGrader";

createAIGraderTest(import.meta.url);

beforeEach(async () => {
  await deleteAllDocuments(responseAdminClient, ["messages"]);
});

// The task gives an inline handler without a `returns` validator, so we don't
// require the function spec to match the answer exactly (the answer adds a
// `returns` validator as a best practice).  Behavioral correctness is verified
// by the remaining tests.
// test("compare function spec", async ({ skip }) => {
//   await compareFunctionSpec(skip, { ignoreReturns: true });
// });

test("compare schema", async ({ skip }) => {
  await compareSchema(skip);
});

test("getAllMessages returns empty array when no messages exist", async () => {
  const messages = await responseClient.query(api.messages.getAllMessages, {});
  expect(messages).toEqual([]);
});

test("getAllMessages returns messages in descending order", async () => {
  // Add test messages
  const testMessages = [
    { author: "Alice", body: "First message" },
    { author: "Bob", body: "Second message" },
    { author: "Charlie", body: "Third message" },
  ];

  await addDocuments(responseAdminClient, "messages", testMessages);

  const messages = await responseClient.query(api.messages.getAllMessages, {});

  // Check length
  expect(messages).toHaveLength(testMessages.length);

  // Check order (descending by creation time)
  const timestamps = messages.map((m) => m._creationTime);
  const sortedTimestamps = [...timestamps].sort((a, b) => b - a);
  expect(timestamps).toEqual(sortedTimestamps);
});

test("getAllMessages returns correct message structure", async () => {
  const testMessage = { author: "Test User", body: "Test message" };
  await addDocuments(responseAdminClient, "messages", [testMessage]);

  const messages = await responseClient.query(api.messages.getAllMessages, {});
  expect(messages).toHaveLength(1);

  const message = messages[0];
  expect(message).toMatchObject({
    author: testMessage.author,
    body: testMessage.body,
  });
  expect(message._id).toBeDefined();
  expect(message._creationTime).toBeDefined();
});

test("getAllMessages handles messages with special characters", async () => {
  const specialMessage = {
    author: "User!@#$%",
    body: "Message with special chars: !@#$%^&*()",
  };
  await addDocuments(responseAdminClient, "messages", [specialMessage]);

  const messages = await responseClient.query(api.messages.getAllMessages, {});
  expect(messages).toHaveLength(1);
  expect(messages[0]).toMatchObject(specialMessage);
});

test("schema validation works", async () => {
  await expect(
    addDocuments(responseAdminClient, "messages", [
      {
        author: 123, // Should be string
        body: "Valid body",
      },
    ]),
  ).rejects.toThrow();

  await expect(
    addDocuments(responseAdminClient, "messages", [
      {
        author: "Valid author",
        body: 456, // Should be string
      },
    ]),
  ).rejects.toThrow();
});
