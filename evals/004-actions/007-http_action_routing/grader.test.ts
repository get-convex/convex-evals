import { expect, test } from "vitest";
import { responseAdminClient } from "../../../grader";
import { api } from "./answer/convex/_generated/api";
import { createAIGraderTest } from "../../../grader/aiGrader";

createAIGraderTest(import.meta.url);

async function getBaseURL(): Promise<string> {
  return await responseAdminClient.query(api.http.getSiteURL, {});
}

test("GET /getFoo returns correct response", async () => {
  const baseUrl = await getBaseURL();
  const response = await fetch(`${baseUrl}/getFoo`);

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("application/json");
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const data = await response.json();
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  expect(data.ok).toBe(true);
});

test("POST /postBar returns correct response", async () => {
  const baseUrl = await getBaseURL();
  const response = await fetch(`${baseUrl}/postBar`, {
    method: "POST",
  });

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("application/json");
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const data = await response.json();
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  expect(data.ok).toBe(true);
});

test("PUT /putBaz returns correct response", async () => {
  const baseUrl = await getBaseURL();
  const response = await fetch(`${baseUrl}/putBaz`, {
    method: "PUT",
  });

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("application/json");
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const data = await response.json();
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  expect(data.ok).toBe(true);
});

test("GET /api/* wildcard returns correct response", async () => {
  const baseUrl = await getBaseURL();
  const testPaths = ["/api/test", "/api/foo/bar", "/api/deeply/nested/path"];

  for (const path of testPaths) {
    const response = await fetch(`${baseUrl}${path}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const data = await response.json();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(data.ok).toBe(true);
  }
});

test("endpoints reject incorrect methods", async () => {
  const baseUrl = await getBaseURL();
  const tests = [
    { path: "/getFoo", method: "POST" },
    { path: "/getFoo", method: "PUT" },
    { path: "/postBar", method: "GET" },
    { path: "/postBar", method: "PUT" },
    { path: "/putBaz", method: "GET" },
    { path: "/putBaz", method: "POST" },
    { path: "/api/test", method: "POST" },
    { path: "/api/test", method: "PUT" },
  ];

  for (const { path, method } of tests) {
    const response = await fetch(`${baseUrl}${path}`, { method });
    expect(response.status).toBe(404);
  }
});

test("non-existent paths return 404", async () => {
  const baseUrl = await getBaseURL();
  const nonExistentPaths = [
    "/nonexistent",
    "/getFooBar",
    "/post",
    "/api", // without trailing path
  ];

  for (const path of nonExistentPaths) {
    const response = await fetch(`${baseUrl}${path}`);
    expect(response.status).toBe(404);
  }
});

test("handles special characters in API paths", async () => {
  const baseUrl = await getBaseURL();
  const specialPaths = [
    "/api/test!@#$%",
    "/api/spaces in path",
    "/api/unicode-∆≈ç√",
  ];

  for (const path of specialPaths) {
    const response = await fetch(`${baseUrl}${encodeURI(path)}`);
    expect(response.status).toBe(200);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const data = await response.json();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(data.ok).toBe(true);
  }
});
