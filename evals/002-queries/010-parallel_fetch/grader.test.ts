import { expect, test } from "vitest";
import {
  responseAdminClient,
  responseClient,
  compareSchema,
  addDocuments,
  listTable,
} from "../../../grader";
import { anyApi } from "convex/server";
import { createAIGraderTest } from "../../../grader/aiGrader";

createAIGraderTest(import.meta.url);

test("compare schema", async ({ skip }) => {
  await compareSchema(skip);
});

test("get author dashboard returns null when user not found", async () => {
  const dashboard = await responseClient.query(
    anyApi.public.getAuthorDashboard,
    {
      email: "nonexistent@example.com",
    },
  );
  expect(dashboard).toBeNull();
});

test("get author dashboard returns complete data", async () => {
  // Create test users
  await addDocuments(responseAdminClient, "users", [
    { name: "Alice", email: "alice@example.com" },
    { name: "Bob", email: "bob@example.com" },
  ]);
  const users = await listTable(responseAdminClient, "users");
  const [user1, user2] = users; // listTable returns in chronological order

  // Create user preferences
  await addDocuments(responseAdminClient, "userPreferences", [
    { userId: user1._id, theme: "dark", notifications: true },
  ]);

  const posts = [];
  for (let i = 0; i < 20; i++) {
    posts.push({
      authorId: user1._id,
      title: `Post ${i + 1}`,
      content: `Content for post ${i + 1}`,
    });
  }
  await addDocuments(responseAdminClient, "posts", posts);
  const allPosts = await listTable(responseAdminClient, "posts");
  const postIds = allPosts.map((p) => p._id);

  // Create reactions
  const reactions = [
    // Reactions for most recent post
    { postId: postIds[19], userId: user1._id, type: "like" },
    { postId: postIds[19], userId: user2._id, type: "like" },
    { postId: postIds[19], userId: user1._id, type: "heart" },

    // Reactions for second most recent post
    { postId: postIds[18], userId: user2._id, type: "celebrate" },
    { postId: postIds[18], userId: user1._id, type: "celebrate" },

    // Reactions for an older post
    { postId: postIds[0], userId: user2._id, type: "like" },
  ];
  await addDocuments(responseAdminClient, "reactions", reactions);

  // Get dashboard for Alice
  const dashboard = await responseClient.query(
    anyApi.public.getAuthorDashboard,
    {
      email: "alice@example.com",
    },
  );

  // Verify user data
  expect(dashboard.user).toEqual({
    name: "Alice",
    email: "alice@example.com",
    theme: "dark",
    notifications: true,
  });

  // Verify posts
  expect(dashboard.posts).toHaveLength(15); // Should only return 15 most recent

  // Most recent post should be first
  expect(dashboard.posts[0].title).toBe("Post 20");
  expect(dashboard.posts[0].reactionCounts).toEqual({
    like: 2,
    heart: 1,
    celebrate: 0,
  });

  // Second most recent post
  expect(dashboard.posts[1].title).toBe("Post 19");
  expect(dashboard.posts[1].reactionCounts).toEqual({
    like: 0,
    heart: 0,
    celebrate: 2,
  });

  // Verify all posts have reaction counts
  for (const post of dashboard.posts) {
    expect(post).toHaveProperty("title");
    expect(post).toHaveProperty("reactionCounts");
    expect(post.reactionCounts).toHaveProperty("like");
    expect(post.reactionCounts).toHaveProperty("heart");
    expect(post.reactionCounts).toHaveProperty("celebrate");
  }
});

test("get author dashboard throws if preferences missing", async () => {
  // Create user without preferences
  await addDocuments(responseAdminClient, "users", [
    { name: "NoPref", email: "nopref@example.com" },
  ]);

  await expect(
    responseClient.query(anyApi.public.getAuthorDashboard, {
      email: "nopref@example.com",
    }),
  ).rejects.toThrow();
});
