import { expect, test, beforeEach } from "vitest";
import {
  responseClient,
  responseAdminClient,
  compareFunctionSpec,
  compareSchema,
  deleteAllDocuments,
  listTable,
} from "../../../grader";
import { api } from "./answer/convex/_generated/api";
import { aiGradeGeneratedOutput } from "../../../grader/aiGrader";

test("AI grader assessment", { timeout: 60000 }, async () => {
  await expect(aiGradeGeneratedOutput(import.meta.url)).resolves.toBe("pass");
});

beforeEach(async () => {
  // Clear the messages table before each test
  await deleteAllDocuments(responseAdminClient, ["messages"]);
});

test("compare function spec", async ({ skip }) => {
  await compareFunctionSpec(skip);
});

test("compare schema", async ({ skip }) => {
  await compareSchema(skip);
});

test("sendMessage successfully inserts a message", async () => {
  const messageData = {
    author: "Alice",
    body: "Hello, World!",
  };

  // Invoke the sendMessage mutation
  await responseClient.mutation(api.messages.sendMessage, messageData);

  // Retrieve all messages from the database
  const messages = await listTable(responseAdminClient, "messages");

  // Expect exactly one message to be present
  expect(messages).toHaveLength(1);

  // Verify the inserted message matches the input data
  expect(messages[0]).toMatchObject(messageData);
});
