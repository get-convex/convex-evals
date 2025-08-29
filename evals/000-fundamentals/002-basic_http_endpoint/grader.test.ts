import { expect, test } from "vitest";
import { siteUrl } from "../../../grader";

test("GET /api/hello returns body + 'there' (empty body => 'there')", async () => {
  const res = await fetch(`${siteUrl}/api/hello`, { method: "GET" });
  expect(res.ok).toBe(true);
  const text = await res.text();
  expect(text).toBe("there");
  const contentType = res.headers.get("content-type");
  expect(contentType && contentType.includes("text/plain")).toBe(true);
});

test("POST /api/messages/* returns empty response body", async () => {
  const res = await fetch(`${siteUrl}/api/messages/123`, {
    method: "POST",
    body: "ignored",
  });
  expect(res.ok).toBe(true);
  const text = await res.text();
  expect(text).toBe("");
});
