import { expect, test } from "vitest";
import { siteUrl } from "../../../grader";
import { createAIGraderTest } from "../../../grader/aiGrader";

createAIGraderTest(import.meta.url);

test("GET /getFoo returns correct response", async () => {
  const response = await fetch(`${siteUrl}/getFoo`);

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("application/json");
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const data = await response.json();
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  expect(data.ok).toBe(true);
});

test("POST /postBar returns correct response", async () => {
  const response = await fetch(`${siteUrl}/postBar`, {
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
  const response = await fetch(`${siteUrl}/putBaz`, {
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
  const testPaths = ["/api/test", "/api/foo/bar", "/api/deeply/nested/path"];

  for (const path of testPaths) {
    const response = await fetch(`${siteUrl}${path}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const data = await response.json();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(data.ok).toBe(true);
  }
});

test("endpoints reject incorrect methods", async () => {
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
    const response = await fetch(`${siteUrl}${path}`, { method });
    expect(response.status).toBe(404);
  }
});

test("non-existent paths return 404", async () => {
  const nonExistentPaths = [
    "/nonexistent",
    "/getFooBar",
    "/post",
    "/api", // without trailing path
  ];

  for (const path of nonExistentPaths) {
    const response = await fetch(`${siteUrl}${path}`);
    expect(response.status).toBe(404);
  }
});

test("handles special characters in API paths", async () => {
  const specialPaths = [
    "/api/test!@#$%",
    "/api/spaces in path",
    "/api/unicode-∆≈ç√",
  ];

  for (const path of specialPaths) {
    const response = await fetch(`${siteUrl}${encodeURI(path)}`);
    expect(response.status).toBe(200);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const data = await response.json();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    expect(data.ok).toBe(true);
  }
});
