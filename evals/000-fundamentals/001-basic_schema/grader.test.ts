import { expect, test } from "vitest";
import {
  responseAdminClient,
  getSchema,
  addDocuments,
  listTable,
  deleteAllDocuments,
} from "../../../grader";

type SimpleSchema = { tables: Array<{ tableName: string }> };

test("has exactly two tables: users and messages", async () => {
  const schemaUnknown: unknown = await getSchema(responseAdminClient);
  expect(schemaUnknown).not.toBeNull();
  const { tables } = schemaUnknown as SimpleSchema;
  const tableNames = tables.map((t) => t.tableName);
  expect(tableNames).toEqual(["messages", "users"]);
});

test("users table enforces single string field: name", async () => {
  await deleteAllDocuments(responseAdminClient, ["users", "messages"]);

  // valid insert
  await addDocuments(responseAdminClient, "users", [{ name: "Alice" }]);
  const users = await listTable(responseAdminClient, "users");
  expect(users.length).toBe(1);

  // extra field should fail
  await expect(
    addDocuments(responseAdminClient, "users", [
      { name: "Bob", extra: "nope" },
    ]),
  ).rejects.toBeDefined();

  // wrong type should fail
  await expect(
    addDocuments(responseAdminClient, "users", [
      { name: 123 as unknown as string },
    ]),
  ).rejects.toBeDefined();

  // missing required field should fail
  await expect(
    addDocuments(responseAdminClient, "users", [
      {} as unknown as { name: string },
    ]),
  ).rejects.toBeDefined();
});

test("messages table enforces two string fields: text and authorName", async () => {
  await deleteAllDocuments(responseAdminClient, ["users", "messages"]);

  // valid insert
  await addDocuments(responseAdminClient, "messages", [
    { text: "Hello", authorName: "Alice" },
  ]);
  const messages = await listTable(responseAdminClient, "messages");
  expect(messages.length).toBe(1);

  // extra field should fail
  await expect(
    addDocuments(responseAdminClient, "messages", [
      { text: "Hi", authorName: "Bob", extra: "nope" },
    ]),
  ).rejects.toBeDefined();

  // wrong types should fail
  await expect(
    addDocuments(responseAdminClient, "messages", [
      { text: 42 as unknown as string, authorName: "Alice" },
    ]),
  ).rejects.toBeDefined();
  await expect(
    addDocuments(responseAdminClient, "messages", [
      { text: "Hello", authorName: 99 as unknown as string },
    ]),
  ).rejects.toBeDefined();

  // missing required fields should fail
  await expect(
    addDocuments(responseAdminClient, "messages", [
      { text: "Hello" } as unknown as { text: string; authorName: string },
    ]),
  ).rejects.toBeDefined();
  await expect(
    addDocuments(responseAdminClient, "messages", [
      { authorName: "Alice" } as unknown as {
        text: string;
        authorName: string;
      },
    ]),
  ).rejects.toBeDefined();
});
