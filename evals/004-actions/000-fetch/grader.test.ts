import { expect, test } from "vitest";
import { responseClient, compareFunctionSpec } from "../../../grader";
import { anyApi } from "convex/server";

test("compare function spec", async ({ skip }) => {
  await compareFunctionSpec(skip);
});

test("fetches data from httpbin", async () => {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const response = await responseClient.action(
    anyApi.index.fetchFromHttpBin,
    {}
  );

  // Verify response structure
  expect(response).toBeDefined();
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  expect(response.url).toBe("https://httpbin.org/get");
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  expect(response.headers).toBeDefined();
});

test("response contains standard httpbin fields", async () => {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const response = await responseClient.action(
    anyApi.index.fetchFromHttpBin,
    {}
  );

  // Check for standard httpbin response fields
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  expect(response.origin).toBeDefined();
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  expect(response.headers).toHaveProperty("Host");
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  expect(response.headers).toHaveProperty("Accept");
});

test("returns valid JSON", async () => {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const response = await responseClient.action(
    anyApi.index.fetchFromHttpBin,
    {}
  );

  // Verify we can stringify and parse the response
  const jsonString = JSON.stringify(response);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  expect(() => JSON.parse(jsonString)).not.toThrow();
});
