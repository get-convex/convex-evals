import { expect, test } from "vitest";
import { responseClient } from "../../../grader";
import { api } from "./answer/convex/_generated/api";
import { createAIGraderTest } from "../../../grader/aiGrader";
import { Id } from "./answer/convex/_generated/dataModel";

createAIGraderTest(import.meta.url);

test("writes and reads text content", async () => {
  const testText = "Hello, world!";

  // Write the text to storage
  const { storageId } = await responseClient.action(
    api.index.writeTextToStorage,
    {
      text: testText,
    },
  );

  // Read the text back
  const retrievedText = await responseClient.action(
    api.index.readTextFromStorage,
    {
      storageId,
    },
  );

  expect(retrievedText).toBe(testText);
});

test("handles empty text", async () => {
  const emptyText = "";

  const { storageId } = await responseClient.action(
    api.index.writeTextToStorage,
    {
      text: emptyText,
    },
  );

  const retrievedText = await responseClient.action(
    api.index.readTextFromStorage,
    {
      storageId,
    },
  );

  expect(retrievedText).toBe(emptyText);
});

test("handles long text content", async () => {
  const longText = "a".repeat(1000) + "b".repeat(1000) + "c".repeat(1000);

  const { storageId } = await responseClient.action(
    api.index.writeTextToStorage,
    {
      text: longText,
    },
  );

  const retrievedText = await responseClient.action(
    api.index.readTextFromStorage,
    {
      storageId,
    },
  );

  expect(retrievedText).toBe(longText);
  expect(retrievedText.length).toBe(3000);
});

test("handles special characters", async () => {
  const specialChars = "!@#$%^&*()_+-=[]{}|;:'\",.<>/?\n\t";

  const { storageId } = await responseClient.action(
    api.index.writeTextToStorage,
    {
      text: specialChars,
    },
  );

  const retrievedText = await responseClient.action(
    api.index.readTextFromStorage,
    {
      storageId,
    },
  );

  expect(retrievedText).toBe(specialChars);
});

test("returns valid URL", async () => {
  const testText = "Test content";

  const { url } = await responseClient.action(api.index.writeTextToStorage, {
    text: testText,
  });

  expect(url).toMatch(/^https?:\/\//);
});

test("readTextFromStorage throws for invalid storageId", async () => {
  await expect(
    responseClient.action(api.index.readTextFromStorage, {
      storageId: "invalid" as unknown as Id<"_storage">,
    }),
  ).rejects.toThrow();
});

test("handles Unicode characters", async () => {
  const unicodeText = "Hello, 世界! 👋 🌍";

  const { storageId } = await responseClient.action(
    api.index.writeTextToStorage,
    {
      text: unicodeText,
    },
  );

  const retrievedText = await responseClient.action(
    api.index.readTextFromStorage,
    {
      storageId,
    },
  );

  expect(retrievedText).toBe(unicodeText);
});
