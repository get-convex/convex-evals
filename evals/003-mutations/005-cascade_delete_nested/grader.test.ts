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
  await deleteAllDocuments(responseAdminClient, [
    "users",
    "posts",
    "comments",
    "likes",
  ]);
});

test("compare schema", async ({ skip }) => {
  await compareSchema(skip);
});

test("compare function spec", async ({ skip }) => {
  await compareFunctionSpec(skip);
});

test("deletes user with no associated data", async () => {
  // Create a test user
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
  const userId = users[0]._id;

  // Delete the user
  await responseClient.mutation(anyApi.index.deleteUser, { userId });

  // Verify user is deleted
  const remainingUsers = await listTable(responseAdminClient, "users");
  expect(remainingUsers).toHaveLength(0);
});

test("deletes user and all associated content", async () => {
  // Create test users
  await addDocuments(responseAdminClient, "users", [
    { name: "User 1", email: "user1@example.com" },
    { name: "User 2", email: "user2@example.com" },
  ]);
  const users = (await listTable(
    responseAdminClient,
    "users"
  ));
  const user1Id = users[0]._id;
  const user2Id = users[1]._id;

  // Create posts
  await addDocuments(responseAdminClient, "posts", [
    { authorId: user1Id, title: "Post 1", content: "Content 1" },
    { authorId: user1Id, title: "Post 2", content: "Content 2" },
    { authorId: user2Id, title: "Post 3", content: "Content 3" },
  ]);
  const posts = (await listTable(
    responseAdminClient,
    "posts"
  ));
  const post1Id = posts[0]._id;
  const post2Id = posts[1]._id;
  const post3Id = posts[2]._id;

  // Create comments
  await addDocuments(responseAdminClient, "comments", [
    { authorId: user1Id, postId: post1Id, content: "Comment 1" },
    { authorId: user2Id, postId: post1Id, content: "Comment 2" },
    { authorId: user1Id, postId: post2Id, content: "Comment 3" },
    { authorId: user2Id, postId: post2Id, content: "Comment 4" },
    { authorId: user2Id, postId: post3Id, content: "Comment 5" },
  ]);

  // Create likes
  await addDocuments(responseAdminClient, "likes", [
    { userId: user1Id, postId: post1Id },
    { userId: user2Id, postId: post1Id },
    { userId: user1Id, postId: post2Id },
    { userId: user2Id, postId: post2Id },
    { userId: user2Id, postId: post3Id },
  ]);

  // Delete user1
  await responseClient.mutation(anyApi.index.deleteUser, { userId: user1Id });

  // Verify user1 and their content is deleted
  const remainingUsers = (await listTable(
    responseAdminClient,
    "users"
  )) as Doc<"users">[];
  const remainingPosts = (await listTable(
    responseAdminClient,
    "posts"
  ));
  const remainingComments = (await listTable(
    responseAdminClient,
    "comments"
  ));
  const remainingLikes = (await listTable(
    responseAdminClient,
    "likes"
  ));

  expect(remainingUsers).toHaveLength(1);
  expect(remainingUsers.find((user) => user._id === user1Id)).toBeUndefined();

  expect(remainingPosts).toHaveLength(1);
  expect(remainingPosts[0].authorId).toBe(user2Id);

  expect(remainingComments).toHaveLength(1);
  expect(remainingComments[0].authorId).toBe(user2Id);

  expect(remainingLikes).toHaveLength(1);
  expect(remainingLikes[0].userId).toBe(user2Id);
});
