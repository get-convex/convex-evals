import { expect, test } from "vitest";
import { responseClient } from "../../../grader";
import { api } from "./answer/convex/_generated/api";
import { createAIGraderTest } from "../../../grader/aiGrader";

createAIGraderTest(import.meta.url);

test("processes string input correctly", async () => {
  const result = await responseClient.action(api.index.processWithNode, {
    data: "test string",
  });

  expect(result).toEqual({
    hash: "d5579c46dfcc7f18207013e65b44e4cb4e2c2298f4ac457ba8f82743f31e930b",
    normalizedPath: "/some/test/path",
  });
});

test("generates consistent hashes", async () => {
  const input = "hello world";

  const result1 = await responseClient.action(api.index.processWithNode, {
    data: input,
  });

  const result2 = await responseClient.action(api.index.processWithNode, {
    data: input,
  });

  expect(result1.hash).toBe(result2.hash);
  expect(result1.hash).toBe(
    "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
  );
});

test("handles empty string input", async () => {
  const result = await responseClient.action(api.index.processWithNode, {
    data: "",
  });

  expect(result.hash).toBe(
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  ); // Empty string SHA-256
  expect(result.normalizedPath).toBe("/some/test/path");
});

test("handles long string input", async () => {
  const longString = "a".repeat(1000);

  const result = await responseClient.action(api.index.processWithNode, {
    data: longString,
  });

  expect(result.hash).toHaveLength(64); // SHA-256 hash is always 64 characters
  expect(result.normalizedPath).toBe("/some/test/path");
});

test("handles special characters", async () => {
  const specialChars = "!@#$%^&*()_+-=[]{}|;:'\",.<>/?";

  const result = await responseClient.action(api.index.processWithNode, {
    data: specialChars,
  });

  expect(result.hash).toHaveLength(64);
  expect(result.normalizedPath).toBe("/some/test/path");
});

test("hash is hexadecimal string", async () => {
  const result = await responseClient.action(api.index.processWithNode, {
    data: "test",
  });

  expect(result.hash).toMatch(/^[0-9a-f]{64}$/);
});

test("normalizedPath is consistent", async () => {
  const results = await Promise.all([
    responseClient.action(api.index.processWithNode, { data: "test1" }),
    responseClient.action(api.index.processWithNode, { data: "test2" }),
    responseClient.action(api.index.processWithNode, { data: "test3" }),
  ]);

  for (const result of results) {
    expect(result.normalizedPath).toBe("/some/test/path");
  }
});
