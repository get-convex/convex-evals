import { expect, test } from "vitest";
import {
  responseAdminClient,
  responseClient,
  compareSchema,
  addDocuments,
  listTable,
} from "../../../grader";
import { anyApi } from "convex/server";

test("compare schema", async ({ skip }) => {
  await compareSchema(skip);
});

test("deletes existing user by id and returns null", async () => {
  await addDocuments(responseAdminClient, "users", [
    { email: "a@example.com", name: "A", age: 20 },
  ]);
  const usersBefore = await listTable(responseAdminClient, "users");
  const id = usersBefore[0]._id;

  const result = await responseClient.mutation(anyApi.index.deleteUserById, {
    id,
  });
  expect(result).toBeNull();

  const usersAfter = await listTable(responseAdminClient, "users");
  expect(usersAfter.find((u: { _id: string }) => u._id === id)).toBeUndefined();
});
