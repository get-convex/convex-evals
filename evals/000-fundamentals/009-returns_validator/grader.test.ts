import { expect, test } from "vitest";
import {
  responseAdminClient,
  responseClient,
  addDocuments,
  listTable,
  deleteAllDocuments,
} from "../../../grader";
import { api } from "./answer/convex/_generated/api";
import { Doc, Id } from "./answer/convex/_generated/dataModel";
import { beforeEach } from "node:test";
import { WithoutSystemFields } from "convex/server";

beforeEach(async () => {
  await deleteAllDocuments(responseAdminClient, ["users", "posts"]);
});

async function createTestUser(): Promise<Id<"users">> {
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
  return users.at(-1)!._id;
}

async function createTestPosts(
  userId: Id<"users">,
  toAdd: WithoutSystemFields<Doc<"posts">>[],
): Promise<Id<"posts">[]> {
  await addDocuments(responseAdminClient, "posts", toAdd);
  const posts = (await listTable(
    responseAdminClient,
    "posts",
  )) as Doc<"posts">[];
  return posts.slice(-toAdd.length).map((post) => post._id);
}

test("getPost returns raw document with correct type", async () => {
  // Create test user
  const userId = await createTestUser();

  // Create test post
  const [postId] = await createTestPosts(userId, [
    {
      title: "Test Post",
      content: "Test Content",
      authorId: userId,
    },
  ]);

  const post = await responseClient.query(api.index.getPost, {
    postId,
  });

  expect(post).toEqual({
    _id: postId,
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    _creationTime: expect.any(Number),
    title: "Test Post",
    content: "Test Content",
    authorId: userId,
  });

  // Test with non-existent post
  let error = null;
  try {
    await responseClient.query(api.index.getPost, {
      postId: "posts:nonexistent" as Id<"posts">,
    });
  } catch (e) {
    error = e;
  }
  expect(error).toBeDefined();
});

test("getPostWithStatus handles success and error cases", async () => {
  // Create test user
  const userId = await createTestUser();

  // Create test posts
  const postIds = await createTestPosts(userId, [
    {
      title: "Valid Post",
      content: "Test Content",
      authorId: userId,
    },
    {
      title: "",
      content: "Empty Title Post",
      authorId: userId,
    },
  ]);

  // Test successful case
  const successResult = await responseClient.query(
    api.index.getPostWithStatus,
    {
      postId: postIds[0],
    },
  );
  expect(successResult).toEqual({
    success: true,
    post: {
      _id: postIds[0],
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      _creationTime: expect.any(Number),
      title: "Valid Post",
      content: "Test Content",
      authorId: userId,
    },
  });

  // Test empty title case
  const emptyTitleResult = await responseClient.query(
    api.index.getPostWithStatus,
    { postId: postIds[1] },
  );
  expect(emptyTitleResult).toEqual({
    success: false,
    error: "Post title cannot be empty",
  });

  await deleteAllDocuments(responseAdminClient, ["posts"]);

  // Test non-existent post
  const nonExistentResult = await responseClient.query(
    api.index.getPostWithStatus,
    { postId: postIds[0] },
  );
  expect(nonExistentResult).toEqual({
    success: false,
    error: "Post not found",
  });
});

test("getPostWithAuthor returns correct tuple", async () => {
  // Create test user
  const userId = await createTestUser();

  // Create test post
  const [postId] = await createTestPosts(userId, [
    {
      title: "Test Post",
      content: "Test Content",
      authorId: userId,
    },
  ]);

  const result = await responseClient.query(api.index.getPostWithAuthor, {
    postId,
  });

  expect(result).toHaveLength(2);
  expect(result[0]).toEqual({
    _id: userId,
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    _creationTime: expect.any(Number),
    name: "Test User",
    email: "test@example.com",
  });
  expect(result[1]).toEqual({
    _id: postId,
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    _creationTime: expect.any(Number),
    title: "Test Post",
    content: "Test Content",
    authorId: userId,
  });

  // Test with non-existent post
  let error = null;
  try {
    await responseClient.query(api.index.getPostWithAuthor, {
      postId: "posts:nonexistent" as Id<"posts">,
    });
  } catch (e) {
    error = e;
  }
  expect(error).toBeDefined();
});
