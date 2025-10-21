import { expect, test } from "vitest";
import {
  responseClient,
  responseAdminClient,
  compareSchema,
  addDocuments,
  listTable,
} from "../../../grader";
import { anyApi } from "convex/server";

test("compare schema", async ({ skip }) => {
  await compareSchema(skip);
});

test("update user error", async () => {
  let error: any = undefined;
  try {
    await responseClient.mutation(anyApi.index.updateUserEmail, {
      email: "jordan@convex.dev",
      name: "Jordan",
    });
  } catch (e) {
    error = e;
  }
  expect(error).toBeDefined();
  expect(error.toString()).toContain("ArgumentValidationError");
});

test("update user email success", async () => {
  // Seed user
  await addDocuments(responseAdminClient, "users", [
    { email: "old@example.com", name: "Old", age: 30 },
  ]);
  const before = await listTable(responseAdminClient, "users");
  const id = before[0]._id as string;

  // Update email
  await responseClient.mutation(anyApi.index.updateUserEmail, {
    id,
    email: "new@example.com",
  });

  const after = await listTable(responseAdminClient, "users");
  const updated = after.find((u: any) => u._id === id);
  expect(updated?.email).toBe("new@example.com");
});

test("update user email for non-existent id throws", async () => {
  let error: any;
  try {
    await responseClient.mutation(anyApi.index.updateUserEmail, {
      id: "nonexistent_id" as unknown as string,
      email: "x@example.com",
    });
  } catch (e) {
    error = e;
  }
  expect(error).toBeDefined();
});
