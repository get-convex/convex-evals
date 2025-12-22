import { expect, test } from "vitest";
import {
  responseAdminClient,
  compareFunctionSpec,
  compareSchema,
  addDocuments,
  listTable,
  deleteAllDocuments,
} from "../../../grader";
import { api, internal } from "./answer/convex/_generated/api";
import { Doc, Id } from "./answer/convex/_generated/dataModel";
import { beforeEach } from "vitest";
import { createAIGraderTest } from "../../../grader/aiGrader";

createAIGraderTest(import.meta.url);

beforeEach(async () => {
  await deleteAllDocuments(responseAdminClient, ["users", "posts"]);
});

test("compare schema", async ({ skip }) => {
  await compareSchema(skip);
});

async function setupTestData(): Promise<{
  userId: Id<"users">;
  postIds: Id<"posts">[];
}> {
  // Create a test user
  await addDocuments(responseAdminClient, "users", [
    { name: "Test User", email: "test@example.com" },
  ]);
  const users = (await listTable(
    responseAdminClient,
    "users",
  )) as Doc<"users">[];
  const userId = users[0]._id;

  // Create some test posts
  await addDocuments(responseAdminClient, "posts", [
    { userId, content: "Post 1" },
    { userId, content: "Post 2" },
  ]);
  const posts = (await listTable(
    responseAdminClient,
    "posts",
  )) as Doc<"posts">[];
  const [post1Id, post2Id] = posts.map((p) => p._id);

  return { userId, postIds: [post1Id, post2Id] };
}

test("getUserByEmail returns correct user", async () => {
  const { userId } = await setupTestData();

  /* eslint-disable */
  const user = await responseAdminClient.query(
    internal.users.getUserByEmail as any,
    {
      email: "test@example.com",
    },
  );
  /* eslint-enable */

  expect(user).toBeDefined();
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  expect(user._id).toBe(userId);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  expect(user.email).toBe("test@example.com");
});

test("getUserByEmail returns null for non-existent user", async () => {
  /* eslint-disable */
  const user = await responseAdminClient.query(
    internal.users.getUserByEmail as any,
    {
      email: "nonexistent@example.com",
    },
  );
  /* eslint-enable */
  expect(user).toBeNull();
});

test("getPostsByUserId returns correct posts", async () => {
  const { userId } = await setupTestData();

  const posts = await responseAdminClient.query(api.posts.getUserAndPosts, {
    email: "test@example.com",
  });

  expect(Array.isArray(posts.posts)).toBe(true);
  expect(posts.posts).toHaveLength(2);
  expect(posts.user?._id).toBe(userId);
});

test("getUserAndPosts returns null user and empty posts for non-existent email", async () => {
  const result = await responseAdminClient.query(api.posts.getUserAndPosts, {
    email: "nonexistent@example.com",
  });

  expect(result.user).toBeNull();
  expect(result.posts).toEqual([]);
});
