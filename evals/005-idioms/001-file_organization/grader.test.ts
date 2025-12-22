import { expect, test } from "vitest";
import { responseClient } from "../../../grader";
import { api } from "./answer/convex/_generated/api";
import { createAIGraderTest } from "../../../grader/aiGrader";

createAIGraderTest(import.meta.url);

test("can create and get user", async () => {
  const userData = {
    name: "Test User",
    email: "test@example.com",
  };

  const userId = await responseClient.mutation(api.users.create, userData);
  expect(userId).toBeDefined();

  const user = await responseClient.query(api.users.get, { id: userId });
  expect(user).toMatchObject(userData);
});

test("can create and get post", async () => {
  // Create a user first
  const userId = await responseClient.mutation(api.users.create, {
    name: "Post Author",
    email: "author@example.com",
  });

  const postData = {
    userId,
    title: "Test Post",
    content: "This is a test post",
  };

  const postId = await responseClient.mutation(api.posts.create, postData);
  expect(postId).toBeDefined();

  const post = await responseClient.query(api.posts.get, { id: postId });
  expect(post).toMatchObject(postData);
});

test("can delete user", async () => {
  const userId = await responseClient.mutation(api.users.create, {
    name: "To Delete",
    email: "delete@example.com",
  });

  await responseClient.mutation(api.users.destroy, { id: userId });

  await expect(
    responseClient.query(api.users.get, { id: userId }),
  ).rejects.toThrow("User not found");
});

test("can delete post", async () => {
  const userId = await responseClient.mutation(api.users.create, {
    name: "Post Owner",
    email: "owner@example.com",
  });

  const postId = await responseClient.mutation(api.posts.create, {
    userId,
    title: "To Delete",
    content: "This post will be deleted",
  });

  await responseClient.mutation(api.posts.destroy, { id: postId });

  await expect(
    responseClient.query(api.posts.get, { id: postId }),
  ).rejects.toThrow("Post not found");
});

test("posts index works with userId", async () => {
  const userId = await responseClient.mutation(api.users.create, {
    name: "Multi Post User",
    email: "multi@example.com",
  });

  // Create multiple posts for the same user
  const postIds = await Promise.all([
    responseClient.mutation(api.posts.create, {
      userId,
      title: "Post 1",
      content: "Content 1",
    }),
    responseClient.mutation(api.posts.create, {
      userId,
      title: "Post 2",
      content: "Content 2",
    }),
  ]);

  // Check that all posts are retrievable
  for (const postId of postIds) {
    const post = await responseClient.query(api.posts.get, { id: postId });
    expect(post.userId).toBe(userId);
  }
});

test("schema validations work", async () => {
  // Test invalid user data
  await expect(
    /* eslint-disable */
    responseClient.mutation(api.users.create, {
      name: 123, // Should be string
      email: "test@example.com",
    } as any),
  ).rejects.toThrow();
  /* eslint-enable */

  // Test invalid post data
  const userId = await responseClient.mutation(api.users.create, {
    name: "Valid User",
    email: "valid@example.com",
  });

  /* eslint-disable */
  await expect(
    responseClient.mutation(api.posts.create, {
      userId,
      title: 123, // Should be string
      content: "Valid content",
    } as any),
  ).rejects.toThrow();
  /* eslint-enable */
});
