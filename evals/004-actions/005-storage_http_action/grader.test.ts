import { expect, test } from "vitest";
import { siteUrl } from "../../../grader";
import { createAIGraderTest } from "../../../grader/aiGrader";

createAIGraderTest(import.meta.url);

const storeUrl = `${siteUrl}/store`;

test("stores request body and returns valid JSON", async () => {
  const testData = "Hello, World!";
  const response = await fetch(storeUrl, {
    method: "POST",
    body: testData,
  });

  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Type")).toBe("application/json");

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const data = await response.json();
  expect(data).toHaveProperty("storageId");
  expect(data).toHaveProperty("url");
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  expect(typeof data.storageId).toBe("string");
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  expect(typeof data.url).toBe("string");
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  expect(data.url).toMatch(/^https?:\/\//);
});

test("handles empty request body", async () => {
  const response = await fetch(storeUrl, {
    method: "POST",
    body: "",
  });

  expect(response.status).toBe(200);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const data = await response.json();
  expect(data).toHaveProperty("storageId");
  expect(data).toHaveProperty("url");
});

test("handles binary data", async () => {
  const binaryData = new Uint8Array([1, 2, 3, 4, 5]);
  const response = await fetch(storeUrl, {
    method: "POST",
    body: binaryData,
  });

  expect(response.status).toBe(200);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const data = await response.json();
  expect(data).toHaveProperty("storageId");
  expect(data).toHaveProperty("url");
});

test("handles large request body", async () => {
  const largeData = "x".repeat(1024 * 1024); // 1MB of data
  const response = await fetch(storeUrl, {
    method: "POST",
    body: largeData,
  });

  expect(response.status).toBe(200);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const data = await response.json();
  expect(data).toHaveProperty("storageId");
  expect(data).toHaveProperty("url");
});

test("stored content is retrievable", async () => {
  const testContent = "Test content for retrieval";
  const storeResponse = await fetch(storeUrl, {
    method: "POST",
    body: testContent,
  });

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const { url } = await storeResponse.json();

  // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
  const contentResponse = await fetch(url);
  expect(contentResponse.status).toBe(200);
  const retrievedContent = await contentResponse.text();
  expect(retrievedContent).toBe(testContent);
});

test("rejects non-POST requests", async () => {
  const methods = ["GET", "PUT", "DELETE", "PATCH"];

  for (const method of methods) {
    const response = await fetch(storeUrl, {
      method,
    });

    expect(response.status).toBe(404);
  }
});
