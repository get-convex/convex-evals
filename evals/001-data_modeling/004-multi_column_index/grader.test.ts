import { expect, test } from "vitest";
import {
  responseAdminClient,
  addDocuments,
  listTable,
  hasIndexOn,
  hasIndexWithPrefix,
} from "../../../grader";

test("messages table with author_email and sent_at inserts", async () => {
  await addDocuments(responseAdminClient, "messages", [
    { content: "Hi", author_email: "a@example.com", sent_at: Date.now() },
  ]);
  const rows = await listTable(responseAdminClient, "messages");
  expect(rows.length).toBeGreaterThan(0);
});

test("schema has a composite index on (author_email, sent_at)", async () => {
  const ok = await hasIndexWithPrefix(responseAdminClient, "messages", [
    "author_email",
    "sent_at",
  ]);
  expect(ok).toBe(true);
});
