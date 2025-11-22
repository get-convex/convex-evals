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

beforeEach(async () => {
  await deleteAllDocuments(responseAdminClient, ["documents"]);
});

test("compare schema", async ({ skip }) => {
  await compareSchema(skip);
});

test("paginateDocuments returns empty page when no documents exist", async () => {
  const result = await responseClient.query(api.index.paginateDocuments, {
    paginationOpts: { numItems: 10, cursor: null },
  });

  expect(result.page).toEqual([]);
  expect(result.isDone).toBe(true);
});

test("paginateDocuments returns documents in correct order", async () => {
  const documents = [
    { title: "First", content: "Content 1", createdAt: 1000 },
    { title: "Second", content: "Content 2", createdAt: 2000 },
    { title: "Third", content: "Content 3", createdAt: 3000 },
  ];
  await addDocuments(responseAdminClient, "documents", documents);

  const result = await responseClient.query(api.index.paginateDocuments, {
    paginationOpts: { numItems: 10, cursor: null },
  });

  expect(result.page).toHaveLength(3);
  expect(result.page.map((doc) => doc.title)).toEqual([
    "Third",
    "Second",
    "First",
  ]);
  expect(result.isDone).toBe(true);
});

test("paginateDocuments respects page size", async () => {
  const documents = Array.from({ length: 5 }, (_, i) => ({
    title: `Doc ${i + 1}`,
    content: `Content ${i + 1}`,
    createdAt: (i + 1) * 1000,
  }));
  await addDocuments(responseAdminClient, "documents", documents);

  // First page
  const firstPage = await responseClient.query(api.index.paginateDocuments, {
    paginationOpts: { numItems: 2, cursor: null },
  });

  expect(firstPage.page).toHaveLength(2);
  expect(firstPage.isDone).toBe(false);
  expect(firstPage.continueCursor).toBeDefined();

  // Second page
  const secondPage = await responseClient.query(api.index.paginateDocuments, {
    paginationOpts: {
      numItems: 2,
      cursor: firstPage.continueCursor,
    },
  });

  expect(secondPage.page).toHaveLength(2);
  expect(secondPage.isDone).toBe(false);

  // Last page
  const lastPage = await responseClient.query(api.index.paginateDocuments, {
    paginationOpts: {
      numItems: 2,
      cursor: secondPage.continueCursor,
    },
  });

  expect(lastPage.page).toHaveLength(1);
  expect(lastPage.isDone).toBe(true);
});

test("paginateDocuments maintains consistent ordering across pages", async () => {
  // Create test documents with timestamps spaced apart
  const documents = Array.from({ length: 10 }, (_, i) => ({
    title: `Doc ${i + 1}`,
    content: `Content ${i + 1}`,
    createdAt: (i + 1) * 1000,
  }));
  await addDocuments(responseAdminClient, "documents", documents);

  const allTitles: string[] = [];
  let cursor: string | null = null;
  let isDone = false;

  // Collect all documents through pagination
  while (!isDone) {
    const result: PaginationResult<Doc<"documents">> =
      await responseClient.query(api.index.paginateDocuments, {
        paginationOpts: {
          numItems: 3,
          cursor,
        },
      });

    allTitles.push(...result.page.map((doc) => doc.title));
    cursor = result.continueCursor;
    isDone = result.isDone;
  }

  // Verify ordering
  const expectedTitles = [...documents]
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((doc) => doc.title);

  expect(allTitles).toEqual(expectedTitles);
});

test("paginateDocuments handles very small page sizes", async () => {
  const documents = Array.from({ length: 3 }, (_, i) => ({
    title: `Doc ${i + 1}`,
    content: `Content ${i + 1}`,
    createdAt: (i + 1) * 1000,
  }));
  await addDocuments(responseAdminClient, "documents", documents);

  const result = await responseClient.query(api.index.paginateDocuments, {
    paginationOpts: { numItems: 1, cursor: null },
  });

  expect(result.page).toHaveLength(1);
  expect(result.isDone).toBe(false);
});

test("paginateDocuments returns all fields for each document", async () => {
  const document = {
    title: "Test",
    content: "Test Content",
    createdAt: 1000,
  };
  await addDocuments(responseAdminClient, "documents", [document]);

  const result = await responseClient.query(api.index.paginateDocuments, {
    paginationOpts: { numItems: 1, cursor: null },
  });

  expect(result.page[0]).toMatchObject(document);
});
