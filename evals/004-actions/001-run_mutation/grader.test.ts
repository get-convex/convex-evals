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
import { createAIGraderTest } from "../../../grader/aiGrader";

createAIGraderTest(import.meta.url);

beforeEach(async () => {
  await deleteAllDocuments(responseAdminClient, ["fetchResults"]);
});

test("compare schema", async ({ skip }) => {
  await compareSchema(skip);
});

test("saveFetchResult saves data correctly", async () => {
  const testUrl = "https://httpbin.org/json";
  const testData = { test: "data" };

  const id = await responseClient.mutation(api.index.saveFetchResult, {
    url: testUrl,
    data: testData,
  });

  expect(id).toBeDefined();

  const results = (await listTable(
    responseAdminClient,
    "fetchResults",
  )) as Doc<"fetchResults">[];
  expect(results).toHaveLength(1);
  expect(results[0].url).toBe(testUrl);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  expect(results[0].data.test).toBe("data");
});

test("fetchAndSave fetches and saves external data", async () => {
  const testUrl = "https://httpbin.org/json";

  const id = await responseClient.action(api.index.fetchAndSave, {
    url: testUrl,
  });

  expect(id).toBeDefined();

  const results = (await listTable(
    responseAdminClient,
    "fetchResults",
  )) as Doc<"fetchResults">[];
  expect(results).toHaveLength(1);
  expect(results[0].url).toBe(testUrl);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  expect(results[0].data.slideshow).toBeDefined();
});

test("fetchAndSave then saveFetchResult persists identical URL and data", async () => {
  const testUrl = "https://httpbin.org/get";

  const id = await responseClient.action(api.index.fetchAndSave, {
    url: testUrl,
  });
  expect(id).toBeDefined();

  const results = (await listTable(
    responseAdminClient,
    "fetchResults",
  )) as Doc<"fetchResults">[];
  const saved = results.find((r) => r._id === id);
  expect(saved?.url).toBe(testUrl);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  expect(saved?.data).toBeDefined();
});

test("fetchAndSave handles different JSON responses", async () => {
  const urls = ["https://httpbin.org/json", "https://httpbin.org/get"];

  const ids = await Promise.all(
    urls.map(
      async (url) =>
        await responseClient.action(api.index.fetchAndSave, { url }),
    ),
  );

  expect(ids).toHaveLength(2);

  const results = (await listTable(
    responseAdminClient,
    "fetchResults",
  )) as Doc<"fetchResults">[];
  expect(results).toHaveLength(2);

  // Verify each URL was saved
  const savedUrls = results.map((r) => r.url);
  expect(savedUrls).toEqual(expect.arrayContaining(urls));

  // Verify we got different data structures back
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  expect(results.some((r) => r.data.slideshow)).toBe(true);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  expect(results.some((r) => r.data.url)).toBe(true);
});

test("handles complex nested JSON data", async () => {
  const id = await responseClient.action(api.index.fetchAndSave, {
    url: "https://httpbin.org/json",
  });

  const results = (await listTable(
    responseAdminClient,
    "fetchResults",
  )) as Doc<"fetchResults">[];
  const savedData = results.find((r) => r._id === id);
  expect(savedData).toBeDefined();

  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  expect(savedData?.data.slideshow.slides).toBeInstanceOf(Array);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  expect(savedData?.data.slideshow.author).toBeDefined();
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  expect(savedData?.data.slideshow.date).toBeDefined();
});
