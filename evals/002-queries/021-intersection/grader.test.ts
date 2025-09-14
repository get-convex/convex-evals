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
  await deleteAllDocuments(responseAdminClient, ["users", "posts"]);
});

test("compare schema", async ({ skip }) => {
  await compareSchema(skip);
});

test("getActiveUsersWithPosts returns empty array when no users exist", async () => {
  const result = await responseClient.query(
    api.index.getActiveUsersWithPosts,
    {},
  );
  expect(result).toEqual([]);
});

test("getActiveUsersWithPosts only returns active users", async () => {
  // Create active and inactive users
  const users = [
    { name: "Active User", status: "active" as const },
    { name: "Inactive User", status: "inactive" as const },
  ];
  await addDocuments(responseAdminClient, "users", users);

  const result = await responseClient.query(
    api.index.getActiveUsersWithPosts,
    {},
  );

  expect(result).toHaveLength(1);
  expect(result[0].name).toBe("Active User");
});

test("getActiveUsersWithPosts returns only published posts", async () => {
  // Create an active user
  await addDocuments(responseAdminClient, "users", [
    { name: "Test User", status: "active" as const },
  ]);
  const users = (await listTable(
    responseAdminClient,
    "users",
  )) as Doc<"users">[];
  const userId = users[0]._id;

  // Create published and unpublished posts
  const posts = [
    { authorId: userId, title: "Published Post", published: true },
    { authorId: userId, title: "Unpublished Post", published: false },
  ];
  await addDocuments(responseAdminClient, "posts", posts);

  const result = await responseClient.query(
    api.index.getActiveUsersWithPosts,
    {},
  );

  expect(result[0].posts).toHaveLength(1);
  expect(result[0].posts[0].title).toBe("Published Post");
});

test("getActiveUsersWithPosts returns correct structure", async () => {
  // Create user
  await addDocuments(responseAdminClient, "users", [
    { name: "Test User", status: "active" as const },
  ]);
  const users = (await listTable(
    responseAdminClient,
    "users",
  )) as Doc<"users">[];
  const userId = users[0]._id;

  // Create post
  await addDocuments(responseAdminClient, "posts", [
    { authorId: userId, title: "Test Post", published: true },
  ]);

  const result = await responseClient.query(
    api.index.getActiveUsersWithPosts,
    {},
  );

  expect(result[0]).toMatchObject({
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    userId: expect.any(String),
    name: "Test User",
    posts: [{ title: "Test Post" }],
  });
  // Verify no extra fields
  expect(Object.keys(result[0])).toHaveLength(3);
  expect(Object.keys(result[0].posts[0])).toHaveLength(1);
});

test("getActiveUsersWithPosts handles users with no posts", async () => {
  await addDocuments(responseAdminClient, "users", [
    { name: "No Posts User", status: "active" as const },
  ]);

  const result = await responseClient.query(
    api.index.getActiveUsersWithPosts,
    {},
  );

  expect(result).toHaveLength(1);
  expect(result[0].posts).toEqual([]);
});

test("getActiveUsersWithPosts handles multiple users with multiple posts", async () => {
  // Create users
  const users = [
    { name: "User 1", status: "active" as const },
    { name: "User 2", status: "active" as const },
  ];
  await addDocuments(responseAdminClient, "users", users);
  const userDocs = (await listTable(
    responseAdminClient,
    "users",
  )) as Doc<"users">[];
  const [user1Id, user2Id] = userDocs.map((u) => u._id);

  // Create posts for each user
  const posts = [
    { authorId: user1Id, title: "User 1 Post 1", published: true },
    { authorId: user1Id, title: "User 1 Post 2", published: true },
    { authorId: user2Id, title: "User 2 Post 1", published: true },
  ];
  await addDocuments(responseAdminClient, "posts", posts);

  const result = await responseClient.query(
    api.index.getActiveUsersWithPosts,
    {},
  );

  expect(result).toHaveLength(2);
  const user1Result = result.find((u) => u.name === "User 1");
  const user2Result = result.find((u) => u.name === "User 2");

  expect(user1Result?.posts).toHaveLength(2);
  expect(user2Result?.posts).toHaveLength(1);
});

test("getActiveUsersWithPosts maintains data integrity across users", async () => {
  // Create users
  await addDocuments(responseAdminClient, "users", [
    { name: "Active User 1", status: "active" as const },
    { name: "Active User 2", status: "active" as const },
    { name: "Inactive User", status: "inactive" as const },
  ]);
  const users = (await listTable(
    responseAdminClient,
    "users",
  )) as Doc<"users">[];
  const activeUsers = users.filter((u) => u.status === "active");

  // Create posts with mixed published states
  const posts = activeUsers.flatMap((user) => [
    { authorId: user._id, title: `${user.name} Published`, published: true },
    { authorId: user._id, title: `${user.name} Unpublished`, published: false },
  ]);
  await addDocuments(responseAdminClient, "posts", posts);

  const result = await responseClient.query(
    api.index.getActiveUsersWithPosts,
    {},
  );

  expect(result).toHaveLength(2);
  result.forEach((user) => {
    expect(user.posts).toHaveLength(1);
    expect(user.posts[0].title).toContain("Published");
    expect(user.posts[0].title).toContain(user.name);
  });
});
