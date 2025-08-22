import { expect, test } from "vitest";
import {
  responseAdminClient,
  addDocuments,
  listTable,
  hasIndexWithPrefix,
} from "../../../grader";

test("messages table exists and can insert with author_email", async () => {
  await addDocuments(responseAdminClient, "messages", [
    { content: "Hi", author_email: "a@example.com" },
  ]);
  const rows = await listTable(responseAdminClient, "messages");
  expect(rows.length).toBeGreaterThan(0);
});

test("schema has an index on author_email", async () => {
  const ok = await hasIndexWithPrefix(responseAdminClient, "messages", [
    "author_email",
  ]);
  expect(ok).toBe(true);
});
