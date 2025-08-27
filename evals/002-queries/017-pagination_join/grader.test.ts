import { expect, test } from "vitest";
import {
  responseAdminClient,
  responseClient,
  compareSchema,
  addDocuments,
  deleteAllDocuments,
  listTable,
} from "../../../grader";
import { api } from "./answer/convex/_generated/api";
import { createAIGraderTest } from "../../../grader/aiGrader";

createAIGraderTest(import.meta.url);
import { Doc } from "./answer/convex/_generated/dataModel";
import { beforeEach } from "vitest";

beforeEach(async () => {
  await deleteAllDocuments(responseAdminClient, ["messages", "users"]);
});

test("compare schema", async ({ skip }) => {
  await compareSchema(skip);
});

test("paginateMessagesWithAuthors returns empty page when no messages exist", async () => {
  const result = await responseClient.query(
    api.index.paginateMessagesWithAuthors,
    {
      paginationOpts: { numItems: 10, cursor: null },
    },
  );

  expect(result.page).toEqual([]);
  expect(result.isDone).toBe(true);
});

test("paginateMessagesWithAuthors includes author names with messages", async () => {
  // Create test users
  const users = [{ name: "Alice" }, { name: "Bob" }];
  await addDocuments(responseAdminClient, "users", users);
  const userDocs = (await listTable(
    responseAdminClient,
    "users",
  )) as Doc<"users">[];
  const [alice, bob] = userDocs.slice(-2);

  // Create messages
  const messages = [
    { authorId: alice._id, content: "Hello" },
    { authorId: bob._id, content: "Hi there" },
  ];
  await addDocuments(responseAdminClient, "messages", messages);

  const result = await responseClient.query(
    api.index.paginateMessagesWithAuthors,
    {
      paginationOpts: { numItems: 10, cursor: null },
    },
  );

  expect(result.page).toHaveLength(2);
  expect(result.page.map((m) => m.author)).toEqual(["Bob", "Alice"]);
  expect(result.page.map((m) => m.content)).toEqual(["Hi there", "Hello"]);
});

test("paginateMessagesWithAuthors respects pagination size", async () => {
  // Create a user
  await addDocuments(responseAdminClient, "users", [{ name: "Test User" }]);
  const user = (await listTable(
    responseAdminClient,
    "users",
  )) as Doc<"users">[];
  const userId = user[0]._id;

  // Create multiple messages
  const messages = Array.from({ length: 5 }, (_, i) => ({
    authorId: userId,
    content: `Message ${i + 1}`,
  }));
  await addDocuments(responseAdminClient, "messages", messages);

  // Test pagination
  const firstPage = await responseClient.query(
    api.index.paginateMessagesWithAuthors,
    {
      paginationOpts: { numItems: 2, cursor: null },
    },
  );

  expect(firstPage.page).toHaveLength(2);
  expect(firstPage.isDone).toBe(false);

  const secondPage = await responseClient.query(
    api.index.paginateMessagesWithAuthors,
    {
      paginationOpts: { numItems: 2, cursor: firstPage.continueCursor },
    },
  );

  expect(secondPage.page).toHaveLength(2);
  expect(secondPage.isDone).toBe(false);

  const thirdPage = await responseClient.query(
    api.index.paginateMessagesWithAuthors,
    {
      paginationOpts: { numItems: 2, cursor: secondPage.continueCursor },
    },
  );

  expect(thirdPage.page).toHaveLength(1);
  expect(thirdPage.isDone).toBe(true);
});

test("paginateMessagesWithAuthors maintains correct ordering", async () => {
  // Create a user
  await addDocuments(responseAdminClient, "users", [{ name: "User" }]);
  const user = (await listTable(
    responseAdminClient,
    "users",
  )) as Doc<"users">[];
  const userId = user[0]._id;

  // Create messages in specific order
  const messages = [
    { authorId: userId, content: "First" },
    { authorId: userId, content: "Second" },
    { authorId: userId, content: "Third" },
  ];
  await addDocuments(responseAdminClient, "messages", messages);

  const result = await responseClient.query(
    api.index.paginateMessagesWithAuthors,
    {
      paginationOpts: { numItems: 10, cursor: null },
    },
  );

  expect(result.page.map((m) => m.content)).toEqual([
    "Third",
    "Second",
    "First",
  ]);
});

test("paginateMessagesWithAuthors handles multiple authors correctly", async () => {
  // Create multiple users
  const users = [{ name: "Alice" }, { name: "Bob" }, { name: "Charlie" }];
  await addDocuments(responseAdminClient, "users", users);
  const userDocs = (await listTable(
    responseAdminClient,
    "users",
  )) as Doc<"users">[];
  const [alice, bob, charlie] = userDocs.slice(-3);

  // Create interleaved messages
  const messages = [
    { authorId: alice._id, content: "Alice 1" },
    { authorId: bob._id, content: "Bob 1" },
    { authorId: charlie._id, content: "Charlie 1" },
    { authorId: alice._id, content: "Alice 2" },
  ];
  await addDocuments(responseAdminClient, "messages", messages);

  const result = await responseClient.query(
    api.index.paginateMessagesWithAuthors,
    {
      paginationOpts: { numItems: 10, cursor: null },
    },
  );

  expect(result.page).toHaveLength(4);
  expect(
    result.page.map((m) => ({ author: m.author, content: m.content })),
  ).toEqual([
    { author: "Alice", content: "Alice 2" },
    { author: "Charlie", content: "Charlie 1" },
    { author: "Bob", content: "Bob 1" },
    { author: "Alice", content: "Alice 1" },
  ]);
});

test("paginateMessagesWithAuthors throws error for missing author", async () => {
  // Create a user and then delete it
  await addDocuments(responseAdminClient, "users", [
    { name: "Temporary User" },
  ]);
  const user = (await listTable(
    responseAdminClient,
    "users",
  )) as Doc<"users">[];
  const userId = user[0]._id;

  // Create a message
  await addDocuments(responseAdminClient, "messages", [
    { authorId: userId, content: "Orphaned message" },
  ]);

  // Delete the user
  await deleteAllDocuments(responseAdminClient, ["users"]);

  // Attempt to paginate messages
  await expect(
    responseClient.query(api.index.paginateMessagesWithAuthors, {
      paginationOpts: { numItems: 10, cursor: null },
    }),
  ).rejects.toThrow();
});
