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
  await deleteAllDocuments(responseAdminClient, ["posts", "authors"]);
});

test("compare schema", async ({ skip }) => {
  await compareSchema(skip);
});

test("searchPostsWithAuthors returns empty array when no matches found", async () => {
  const result = await responseClient.query(api.index.searchPostsWithAuthors, {
    query: "nonexistent",
  });

  expect(result).toEqual([]);
});

test("searchPostsWithAuthors finds posts by content", async () => {
  // Create an author
  await addDocuments(responseAdminClient, "authors", [
    { name: "John Doe", email: "john@example.com" },
  ]);
  const authors = (await listTable(
    responseAdminClient,
    "authors",
  )) as Doc<"authors">[];
  const authorId = authors[0]._id;

  // Create test posts
  await addDocuments(responseAdminClient, "posts", [
    {
      title: "Test Post",
      content: "This is a unique test content",
      authorId,
    },
    {
      title: "Another Post",
      content: "Different content here",
      authorId,
    },
  ]);

  const result = await responseClient.query(api.index.searchPostsWithAuthors, {
    query: "unique",
  });

  expect(result).toHaveLength(1);
  expect(result[0].content).toContain("unique");
  expect(result[0].author).toBe("John Doe");
});

test("searchPostsWithAuthors returns 'Unknown Author' for missing authors", async () => {
  // Create an author
  await addDocuments(responseAdminClient, "authors", [
    { name: "Jane Doe", email: "jane@example.com" },
  ]);
  const authors = (await listTable(
    responseAdminClient,
    "authors",
  )) as Doc<"authors">[];
  const authorId = authors[0]._id;

  // Create a post
  await addDocuments(responseAdminClient, "posts", [
    {
      title: "Test Post",
      content: "Searchable content",
      authorId,
    },
  ]);

  // Delete the author
  await deleteAllDocuments(responseAdminClient, ["authors"]);

  const result = await responseClient.query(api.index.searchPostsWithAuthors, {
    query: "Searchable",
  });

  expect(result).toHaveLength(1);
  expect(result[0].author).toBe("Unknown Author");
});

test("searchPostsWithAuthors handles multiple matches", async () => {
  // Create authors
  await addDocuments(responseAdminClient, "authors", [
    { name: "Author 1", email: "author1@example.com" },
    { name: "Author 2", email: "author2@example.com" },
  ]);
  const authors = (await listTable(
    responseAdminClient,
    "authors",
  )) as Doc<"authors">[];
  const [author1Id, author2Id] = authors.map((a) => a._id);

  // Create posts with common search term
  await addDocuments(responseAdminClient, "posts", [
    {
      title: "First Post",
      content: "Common search term here",
      authorId: author1Id,
    },
    {
      title: "Second Post",
      content: "Another common search term",
      authorId: author2Id,
    },
  ]);

  const result = await responseClient.query(api.index.searchPostsWithAuthors, {
    query: "common",
  });

  expect(result).toHaveLength(2);
  expect(new Set(result.map((p) => p.author))).toEqual(
    new Set(["Author 1", "Author 2"]),
  );
});

test("searchPostsWithAuthors returns correct result structure", async () => {
  // Create author
  await addDocuments(responseAdminClient, "authors", [
    { name: "Test Author", email: "test@example.com" },
  ]);
  const authors = (await listTable(
    responseAdminClient,
    "authors",
  )) as Doc<"authors">[];
  const authorId = authors[0]._id;

  // Create post
  await addDocuments(responseAdminClient, "posts", [
    {
      title: "Test Title",
      content: "Test Content",
      authorId,
    },
  ]);

  const result = await responseClient.query(api.index.searchPostsWithAuthors, {
    query: "Test",
  });

  expect(result[0]).toHaveProperty("title");
  expect(result[0]).toHaveProperty("content");
  expect(result[0]).toHaveProperty("author");
  expect(Object.keys(result[0])).toHaveLength(3);
});
