import { expect, test } from "vitest";
import {
  responseAdminClient,
  responseClient,
  compareSchema,
  addDocuments,
} from "../../../grader";
import { anyApi } from "convex/server";

test("compare schema", async ({ skip }) => {
  await compareSchema(skip);
});

test("search articles returns empty array when no matches exist", async () => {
  const articles = await responseClient.query(anyApi.public.searchArticles, {
    searchTerm: "nonexistent",
    author: "alice",
  });
  expect(articles).toEqual([]);
});

test("search articles finds and formats matches correctly", async () => {
  // Load test data with various articles
  const testArticles = [
    {
      title: "JavaScript Basics",
      content:
        "JavaScript is a programming language commonly used in web development. It allows you to create interactive websites.",
      author: "alice",
      tags: ["programming", "web"],
      isPublished: true,
    },
    {
      title: "Advanced JavaScript",
      content:
        "Learn about advanced JavaScript concepts like closures, promises, and async/await. Master modern JavaScript programming.",
      author: "alice",
      tags: ["programming", "advanced"],
      isPublished: true,
    },
    {
      title: "Unpublished JavaScript",
      content: "This is a draft about JavaScript programming.",
      author: "alice",
      tags: ["programming"],
      isPublished: false,
    },
    {
      title: "Python Basics",
      content:
        "Python is another programming language. It's known for its simplicity and readability.",
      author: "bob",
      tags: ["programming", "python"],
      isPublished: true,
    },
  ];
  await addDocuments(responseAdminClient, "articles", testArticles);

  // Test search by alice for "javascript"
  const jsArticles = await responseClient.query(anyApi.public.searchArticles, {
    searchTerm: "javascript",
    author: "alice",
  });

  // Should find two published articles
  expect(jsArticles).toHaveLength(2);

  // Verify article format
  for (const article of jsArticles) {
    expect(article).toHaveProperty("title");
    expect(article).toHaveProperty("author", "alice");
    expect(article).toHaveProperty("preview");
    expect(article).toHaveProperty("tags");
    expect(article.preview.length).toBeLessThanOrEqual(100);
  }

  // Test search by bob
  const bobArticles = await responseClient.query(anyApi.public.searchArticles, {
    searchTerm: "programming",
    author: "bob",
  });

  expect(bobArticles).toHaveLength(1);
  expect(bobArticles[0].title).toBe("Python Basics");
});

test("search articles handles long content correctly", async () => {
  // Create an article with long content
  const longContent =
    "This is a very long article content that goes beyond 100 characters. ".repeat(
      10,
    );
  const testArticles = [
    {
      title: "Long Article",
      content: longContent,
      author: "alice",
      tags: ["long"],
      isPublished: true,
    },
  ];
  await addDocuments(responseAdminClient, "articles", testArticles);

  const articles = await responseClient.query(anyApi.public.searchArticles, {
    searchTerm: "long article",
    author: "alice",
  });

  expect(articles).toHaveLength(1);
  expect(articles[0].preview.length).toBe(100);
  expect(articles[0].preview).toBe(longContent.substring(0, 100));
});

test("search articles returns at most 10 results", async () => {
  // Seed 15 matching published articles for the same author
  const manyArticles = Array.from({ length: 15 }, (_, i) => ({
    title: `Post ${i + 1}`,
    content: `match me content ${i + 1}`,
    author: "alice",
    tags: ["bulk"],
    isPublished: true,
  }));
  await addDocuments(responseAdminClient, "articles", manyArticles);

  const results = await responseClient.query(anyApi.public.searchArticles, {
    searchTerm: "match me",
    author: "alice",
  });

  expect(results.length).toBeLessThanOrEqual(10);
});
