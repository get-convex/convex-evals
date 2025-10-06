import { expect, test } from "vitest";
import { responseAdminClient, addDocuments, listTable } from "../../../grader";

test("users and posts tables accept foreign key", async () => {
  await addDocuments(responseAdminClient, "users", [
    { name: "Alice", email_addresses: ["a@example.com"] },
  ]);
  const users = await listTable(responseAdminClient, "users");
  const userId = (users.at(-1) as { _id: string })._id;

  await addDocuments(responseAdminClient, "posts", [
    { title: "T", author: userId, content: "C" },
  ]);
  const posts = await listTable(responseAdminClient, "posts");
  expect(posts.length).toBeGreaterThan(0);
});
