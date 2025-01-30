import { expect, test } from "vitest";
import {
  responseAdminClient,
  responseClient,
  compareSchema,
  compareFunctionSpec,
  addDocuments,
  deleteAllDocuments,
  listTable,
} from "../../../grader";
import { anyApi } from "convex/server";
import { beforeEach } from "vitest";

beforeEach(async () => {
  await deleteAllDocuments(responseAdminClient, ["users", "documents"]);
});

test("compare schema", async ({ skip }) => {
  await compareSchema(skip);
});

test("compare function spec", async ({ skip }) => {
  await compareFunctionSpec(skip);
});

test("deletes user with no documents", async () => {
  // Add a test user
  await addDocuments(responseAdminClient, "users", [
    {
      name: "Test User",
      email: "test@example.com",
    },
  ]);
  let users = (await listTable(responseAdminClient, "users"));
  const userId = users.at(-1)!._id;

  // Delete the user
  await responseClient.mutation(anyApi.index.deleteUserAndDocuments, {
    userId,
  });

  users = (await listTable(responseAdminClient, "users"));
  expect(users.at(-1)?._id).not.toBe(userId);
});

test("deletes user and all associated documents", async () => {
  // Add test users
  await addDocuments(responseAdminClient, "users", [
    { name: "User 1", email: "user1@example.com" },
    { name: "User 2", email: "user2@example.com" },
  ]);
  let users = (await listTable(responseAdminClient, "users"));
  const userId1 = users.at(-2)!._id;
  const userId2 = users.at(-1)!._id;

  // Add documents for both users
  await addDocuments(responseAdminClient, "documents", [
    { authorId: userId1, title: "Doc 1", content: "Content 1" },
    { authorId: userId1, title: "Doc 2", content: "Content 2" },
    { authorId: userId2, title: "Doc 3", content: "Content 3" },
  ]);

  // Delete user 2 and their documents
  await responseClient.mutation(anyApi.index.deleteUserAndDocuments, {
    userId: userId2,
  });

  // Verify only user 1 remains
  users = (await listTable(responseAdminClient, "users"));
  expect(users.at(-1)!._id).toBe(userId1);

  // Verify only user 1's documents remain
  const remainingDocs = (await listTable(
    responseAdminClient,
    "documents"
  ));
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
    "users"
  ));
  const userId = users.at(-1)!._id;

  // Add many documents
  const documents = Array.from({ length: 50 }, (_, i) => ({
    authorId: userId,
    title: `Document ${i}`,
    content: `Content ${i}`,
  }));
  await addDocuments(responseAdminClient, "documents", documents);

  // Delete the user and their documents
  await responseClient.mutation(anyApi.index.deleteUserAndDocuments, {
    userId,
  });

  // Verify all data is deleted
  const remainingUsers = (await listTable(
    responseAdminClient,
    "users"
  ));
  const remainingDocs = (await listTable(
    responseAdminClient,
    "documents"
  ));
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
    "users"
  ));
  const userId1 = users.at(-2)!._id;
  const userId2 = users.at(-1)!._id;

  // Add documents
  await addDocuments(responseAdminClient, "documents", [
    { authorId: userId1, title: "Doc 1", content: "Content 1" },
    { authorId: userId2, title: "Doc 2", content: "Content 2" },
  ]);

  // Delete both users concurrently
  await Promise.all([
    responseClient.mutation(anyApi.index.deleteUserAndDocuments, {
      userId: userId1,
    }),
    responseClient.mutation(anyApi.index.deleteUserAndDocuments, {
      userId: userId2,
    }),
  ]);

  // Verify all data is deleted
  const remainingUsers = (await listTable(
    responseAdminClient,
    "users"
  ));
  const remainingDocs = (await listTable(
    responseAdminClient,
    "documents"
  ));
  expect(remainingUsers).toHaveLength(0);
  expect(remainingDocs).toHaveLength(0);
});
