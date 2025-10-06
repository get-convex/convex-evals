import { expect, test } from "vitest";
import {
  responseClient,
  responseAdminClient,
  compareSchema,
  listTable,
} from "../../../grader";
import { anyApi } from "convex/server";

test("compare schema", async ({ skip }) => {
  await compareSchema(skip);
});

test("insert user success", async () => {
  const result = await responseClient.mutation(anyApi.index.insertUser, {
    email: "jordan@convex.dev",
    name: "Jordan",
    age: 23,
  });
  expect(result).toBeTypeOf("string");
});

test("insert user error", async () => {
  let error: any = undefined;
  try {
    await responseClient.mutation(anyApi.index.insertUser, {
      email: "jordan@convex.dev",
      name: "Jordan",
    });
  } catch (e) {
    error = e;
  }
  expect(error).toBeDefined();
  expect(error.toString()).toContain("ArgumentValidationError");
});

test("insert user persists fields", async () => {
  const email = "persist@example.com";
  const name = "Persist";
  const age = 42;

  await responseClient.mutation(anyApi.index.insertUser, {
    email,
    name,
    age,
  });

  const users = await listTable(responseAdminClient, "users");
  const found = users.find((u: any) => u.email === email);
  expect(found).toBeDefined();
  expect(found.name).toBe(name);
  expect(found.age).toBe(age);
});
