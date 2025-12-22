import { expect, test } from "vitest";
import {
  responseAdminClient,
  responseClient,
  compareSchema,
  deleteAllDocuments,
  listTable,
} from "../../../grader";
import { api } from "./answer/convex/_generated/api";
import { beforeEach } from "vitest";
import { Doc } from "./answer/convex/_generated/dataModel";

beforeEach(async () => {
  await deleteAllDocuments(responseAdminClient, ["requests"]);
});

test("compare schema", async ({ skip }) => {
  await compareSchema(skip);
});

test("initiateRequest creates new request record", async () => {
  const testUrl = "https://httpbin.org/post";

  const requestId = await responseClient.mutation(api.index.initiateRequest, {
    url: testUrl,
  });

  expect(requestId).toBeDefined();

  const requests = (await listTable(
    responseAdminClient,
    "requests",
  )) as Doc<"requests">[];
  expect(requests).toHaveLength(1);

  const request = requests[0];
  expect(request.url).toBe(testUrl);
  expect(request.status).toBeTypeOf("string");
  expect(request.requestedAt).toBeTypeOf("number");
});

test("initiateRequest reuses existing request", async () => {
  const testUrl = "https://httpbin.org/post";

  // Create first request
  const requestId1 = await responseClient.mutation(api.index.initiateRequest, {
    url: testUrl,
  });

  // Create second request with same URL
  const requestId2 = await responseClient.mutation(api.index.initiateRequest, {
    url: testUrl,
  });

  expect(requestId1).toBe(requestId2);

  const requests = await listTable(responseAdminClient, "requests");
  expect(requests).toHaveLength(1);
});

test("request eventually completes", async () => {
  const testUrl = "https://httpbin.org/post";

  const requestId = await responseClient.mutation(api.index.initiateRequest, {
    url: testUrl,
  });

  // Wait for the request to complete

  const start = Date.now();
  while (Date.now() - start < 2000) {
    const requests = (await listTable(
      responseAdminClient,
      "requests",
    )) as Doc<"requests">[];
    const request = requests.find((r) => r._id === requestId);
    expect(request).toBeDefined();
    if (request?.status === "completed") {
      expect(request?.completedAt).toBeTypeOf("number");
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
});

test("handles multiple concurrent requests", async () => {
  const urls = [
    "https://httpbin.org/post",
    "https://httpbin.org/post?test=1",
    "https://httpbin.org/post?test=2",
  ];

  // Initiate multiple requests concurrently
  const requestIds = await Promise.all(
    urls.map(
      async (url) =>
        await responseClient.mutation(api.index.initiateRequest, { url }),
    ),
  );

  expect(new Set(requestIds).size).toBe(urls.length);

  // Wait for requests to complete
  await new Promise((resolve) => setTimeout(resolve, 2000));

  const requests = (await listTable(
    responseAdminClient,
    "requests",
  )) as Doc<"requests">[];
  expect(requests).toHaveLength(urls.length);

  // Verify all requests completed
  const completedRequests = requests.filter((r) => r.status === "completed");
  expect(completedRequests).toHaveLength(urls.length);

  // Verify timestamps
  for (const request of requests) {
    expect(request.requestedAt).toBeLessThan(request.completedAt!);
  }
});

test("initiateRequest does not duplicate async work for same URL concurrently", async () => {
  const testUrl = "https://httpbin.org/post";

  const ids = await Promise.all([
    responseClient.mutation(api.index.initiateRequest, { url: testUrl }),
    responseClient.mutation(api.index.initiateRequest, { url: testUrl }),
    responseClient.mutation(api.index.initiateRequest, { url: testUrl }),
  ]);

  // All should be same id
  expect(new Set(ids).size).toBe(1);

  // Only one request record
  const records = (await listTable(
    responseAdminClient,
    "requests",
  )) as Doc<"requests">[];
  expect(records).toHaveLength(1);
});

test("handles request failures gracefully", async () => {
  const invalidUrl = "https://invalid-url-that-will-fail.example.com";

  const requestId = await responseClient.mutation(api.index.initiateRequest, {
    url: invalidUrl,
  });

  expect(requestId).toBeDefined();

  // Wait for potential completion
  await new Promise((resolve) => setTimeout(resolve, 2000));

  const requests = (await listTable(
    responseAdminClient,
    "requests",
  )) as Doc<"requests">[];
  const request = requests.find((r) => r._id === requestId);

  expect(request).toBeDefined();
  // Request should still be in pending state since the action failed
  expect(request?.status).toBe("pending");
  expect(request?.completedAt).toBeUndefined();
});
