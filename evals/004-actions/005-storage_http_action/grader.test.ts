import { expect, test } from "vitest";
import { responseAdminClient } from "../../../grader";
import { api } from "./answer/convex/_generated/api";
import { createAIGraderTest } from "../../../grader/aiGrader";

createAIGraderTest(import.meta.url);
import { getSiteURL } from "./answer/convex/http";

async function getStoreURL(): Promise<string> {
  const siteURL = await responseAdminClient.query(api.http.getSiteURL, {});
  return `${siteURL}/store`;
}

test("stores request body and returns valid JSON", async () => {
  const testData = "Hello, World!";
  const storeURL = await getStoreURL();
  const response = await fetch(storeURL, {
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
  const storeURL = await getStoreURL();
  const response = await fetch(storeURL, {
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
  const storeURL = await getStoreURL();
  const response = await fetch(storeURL, {
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
  const storeURL = await getStoreURL();
  const response = await fetch(storeURL, {
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
  const storeURL = await getStoreURL();
  const storeResponse = await fetch(storeURL, {
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
    const storeURL = await getStoreURL();
    const response = await fetch(storeURL, {
      method,
    });

    expect(response.status).toBe(404);
  }
});
