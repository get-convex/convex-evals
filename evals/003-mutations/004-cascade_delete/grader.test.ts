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
import { beforeEach } from "vitest";
import { Doc } from "./answer/convex/_generated/dataModel";

beforeEach(async () => {
  await deleteAllDocuments(responseAdminClient, ["users", "documents"]);
});

test("compare schema", async ({ skip }) => {
  await compareSchema(skip);
});

test("deletes user with no documents", async () => {
  // Add a test user
  await addDocuments(responseAdminClient, "users", [
    {
      name: "Test User",
      email: "test@example.com",
    },
  ]);
  let users = (await listTable(responseAdminClient, "users")) as Doc<"users">[];
  const userId = users.at(-1)!._id;

  // Delete the user
  await responseClient.mutation(api.index.deleteUserAndDocuments, { userId });

  users = (await listTable(responseAdminClient, "users")) as Doc<"users">[];
  expect(users.at(-1)?._id).not.toBe(userId);
});

test("deletes user and all associated documents", async () => {
  // Add test users
  await addDocuments(responseAdminClient, "users", [
    { name: "User 1", email: "user1@example.com" },
    { name: "User 2", email: "user2@example.com" },
  ]);
  let users = (await listTable(responseAdminClient, "users")) as Doc<"users">[];
  const userId1 = users.at(-2)!._id;
  const userId2 = users.at(-1)!._id;

  // Add documents for both users
  await addDocuments(responseAdminClient, "documents", [
    { authorId: userId1, title: "Doc 1", content: "Content 1" },
    { authorId: userId1, title: "Doc 2", content: "Content 2" },
    { authorId: userId2, title: "Doc 3", content: "Content 3" },
  ]);

  // Delete user 2 and their documents
  await responseClient.mutation(api.index.deleteUserAndDocuments, {
    userId: userId2,
  });

  // Verify only user 1 remains
  users = (await listTable(responseAdminClient, "users")) as Doc<"users">[];
  expect(users.at(-1)!._id).toBe(userId1);

  // Verify only user 1's documents remain
  const remainingDocs = (await listTable(
    responseAdminClient,
    "documents",
  )) as Doc<"documents">[];
  expect(remainingDocs).toHaveLength(2);
  expect(remainingDocs[0].authorId).toBe(userId1);
});

test("handles deletion of user with many documents", async () => {
  // Add a test user
  await addDocuments(responseAdminClient, "users", [
    {
      name: "Test User",
      email: "test@example.com",
    },
  ]);
  const users = (await listTable(
    responseAdminClient,
    "users",
  )) as Doc<"users">[];
  const userId = users.at(-1)!._id;

  // Add many documents
  const documents = Array.from({ length: 50 }, (_, i) => ({
    authorId: userId,
    title: `Document ${i}`,
    content: `Content ${i}`,
  }));
  await addDocuments(responseAdminClient, "documents", documents);

  // Delete the user and their documents
  await responseClient.mutation(api.index.deleteUserAndDocuments, { userId });

  // Verify all data is deleted
  const remainingUsers = (await listTable(
    responseAdminClient,
    "users",
  )) as Doc<"users">[];
  const remainingDocs = (await listTable(
    responseAdminClient,
    "documents",
  )) as Doc<"documents">[];
  expect(remainingUsers).toHaveLength(0);
  expect(remainingDocs).toHaveLength(0);
});

test("maintains data consistency with concurrent operations", async () => {
  // Add test users
  await addDocuments(responseAdminClient, "users", [
    { name: "User 1", email: "user1@example.com" },
    { name: "User 2", email: "user2@example.com" },
  ]);
  const users = (await listTable(
    responseAdminClient,
    "users",
  )) as Doc<"users">[];
  const userId1 = users.at(-2)!._id;
  const userId2 = users.at(-1)!._id;

  // Add documents
  await addDocuments(responseAdminClient, "documents", [
    { authorId: userId1, title: "Doc 1", content: "Content 1" },
    { authorId: userId2, title: "Doc 2", content: "Content 2" },
  ]);

  // Delete both users concurrently
  await Promise.all([
    responseClient.mutation(api.index.deleteUserAndDocuments, {
      userId: userId1,
    }),
    responseClient.mutation(api.index.deleteUserAndDocuments, {
      userId: userId2,
    }),
  ]);

  // Verify all data is deleted
  const remainingUsers = (await listTable(
    responseAdminClient,
    "users",
  )) as Doc<"users">[];
  const remainingDocs = (await listTable(
    responseAdminClient,
    "documents",
  )) as Doc<"documents">[];
  expect(remainingUsers).toHaveLength(0);
  expect(remainingDocs).toHaveLength(0);
});

test("throws when deleting non-existent user id", async () => {
  // Create a user, then delete it to get a valid ID that no longer exists
  await addDocuments(responseAdminClient, "users", [
    { name: "Temp User", email: "temp@example.com" },
  ]);
  const users = (await listTable(
    responseAdminClient,
    "users",
  )) as Doc<"users">[];
  const deletedUserId = users.at(-1)!._id;

  // Delete the user first
  await responseClient.mutation(api.index.deleteUserAndDocuments, {
    userId: deletedUserId,
  });

  const beforeUsers = (await listTable(
    responseAdminClient,
    "users",
  )) as Doc<"users">[];
  const beforeDocs = (await listTable(
    responseAdminClient,
    "documents",
  )) as Doc<"documents">[];

  // Try to delete the already-deleted user - should throw "not found"
  await expect(
    responseClient.mutation(api.index.deleteUserAndDocuments, {
      userId: deletedUserId,
    }),
  ).rejects.toThrow(/not found/i);

  const afterUsers = (await listTable(
    responseAdminClient,
    "users",
  )) as Doc<"users">[];
  const afterDocs = (await listTable(
    responseAdminClient,
    "documents",
  )) as Doc<"documents">[];
  expect(afterUsers.length).toBe(beforeUsers.length);
  expect(afterDocs.length).toBe(beforeDocs.length);
});
