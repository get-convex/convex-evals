import { expect, test } from "vitest";
import {
  responseAdminClient,
  responseClient,
  compareSchema,
  addDocuments,
  deleteAllDocuments,
} from "../../../grader";
import { api } from "./answer/convex/_generated/api";
import { beforeEach } from "vitest";
import { PaginationResult } from "convex/server";
import { Doc } from "./answer/convex/_generated/dataModel";
import { createAIGraderTest } from "../../../grader/aiGrader";

createAIGraderTest(import.meta.url);

beforeEach(async () => {
  await deleteAllDocuments(responseAdminClient, ["posts"]);
});

test("compare schema", async ({ skip }) => {
  await compareSchema(skip);
});

test("paginatePosts returns empty page with correct structure when no posts exist", async () => {
  const result = await responseClient.query(api.index.paginatePosts, {
    paginationOpts: { numItems: 10, cursor: null },
  });

  expect(result).toMatchObject({
    page: [],
    isDone: true,
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    continueCursor: expect.any(String),
  });
});

test("paginatePosts returns correct post structure", async () => {
  const post = {
    title: "Test Post",
    content: "Test Content",
  };
  await addDocuments(responseAdminClient, "posts", [post]);

  const result = await responseClient.query(api.index.paginatePosts, {
    paginationOpts: { numItems: 10, cursor: null },
  });

  expect(result.page[0]).toMatchObject({
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    _id: expect.any(String),
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    _creationTime: expect.any(Number),
    ...post,
  });
});

test("paginatePosts respects pagination size", async () => {
  const posts = Array.from({ length: 5 }, (_, i) => ({
    title: `Post ${i + 1}`,
    content: `Content ${i + 1}`,
  }));
  await addDocuments(responseAdminClient, "posts", posts);

  // First page
  const firstPage = await responseClient.query(api.index.paginatePosts, {
    paginationOpts: { numItems: 2, cursor: null },
  });

  expect(firstPage.page).toHaveLength(2);
  expect(firstPage.isDone).toBe(false);

  // Second page
  const secondPage = await responseClient.query(api.index.paginatePosts, {
    paginationOpts: { numItems: 2, cursor: firstPage.continueCursor },
  });

  expect(secondPage.page).toHaveLength(2);
  expect(secondPage.isDone).toBe(false);

  // Last page
  const lastPage = await responseClient.query(api.index.paginatePosts, {
    paginationOpts: { numItems: 2, cursor: secondPage.continueCursor },
  });

  expect(lastPage.page).toHaveLength(1);
  expect(lastPage.isDone).toBe(true);
});

test("paginatePosts maintains consistent ordering across pages", async () => {
  const posts = Array.from({ length: 6 }, (_, i) => ({
    title: `Post ${i + 1}`,
    content: `Content ${i + 1}`,
  }));
  await addDocuments(responseAdminClient, "posts", posts);

  const allTitles: string[] = [];
  let cursor: string | null = null;
  let isDone = false;

  while (!isDone) {
    const result: PaginationResult<Doc<"posts">> = await responseClient.query(
      api.index.paginatePosts,
      {
        paginationOpts: { numItems: 2, cursor },
      },
    );

    allTitles.push(...result.page.map((post: { title: string }) => post.title));
    cursor = result.continueCursor;
    isDone = result.isDone;
  }

  expect(allTitles).toEqual(posts.map((p) => p.title));
});

test("paginatePosts handles single item pages", async () => {
  const posts = [{ title: "Single Post", content: "Test Content" }];
  await addDocuments(responseAdminClient, "posts", posts);

  const result = await responseClient.query(api.index.paginatePosts, {
    paginationOpts: { numItems: 1, cursor: null },
  });

  expect(result.page).toHaveLength(1);
  expect(result.page[0].title).toBe("Single Post");
  if (!result.isDone) {
    const page2 = await responseClient.query(api.index.paginatePosts, {
      paginationOpts: { numItems: 1, cursor: result.continueCursor },
    });
    expect(page2.page).toHaveLength(0);
    expect(page2.isDone).toBe(true);
  }
});

test("paginatePosts returns all required pagination fields", async () => {
  await addDocuments(responseAdminClient, "posts", [
    { title: "Test Post", content: "Content" },
  ]);

  const result = await responseClient.query(api.index.paginatePosts, {
    paginationOpts: { numItems: 1, cursor: null },
  });

  expect(result).toHaveProperty("page");
  expect(result).toHaveProperty("isDone");
  expect(result).toHaveProperty("continueCursor");
  // Optional fields may be undefined
  expect("splitCursor" in result).toBe(true);
  expect("pageStatus" in result).toBe(true);
});

test("paginatePosts throws on empty pages", async () => {
  await expect(
    responseClient.query(api.index.paginatePosts, {
      paginationOpts: { numItems: 0, cursor: null },
    }),
  ).rejects.toThrow();
});

test("paginatePosts handles invalid cursor gracefully", async () => {
  await expect(
    responseClient.query(api.index.paginatePosts, {
      paginationOpts: { numItems: 10, cursor: "invalid_cursor" },
    }),
  ).rejects.toThrow();
});
