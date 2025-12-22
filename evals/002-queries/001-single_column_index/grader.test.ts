import { expect, test } from "vitest";
import {
  responseAdminClient,
  responseClient,
  compareSchema,
  addDocuments,
} from "../../../grader";
import { anyApi } from "convex/server";

test("compare schema", async ({ skip }) => {
  await compareSchema(skip);
});

test("get user by email returns null for non-existent user", async () => {
  const user = await responseClient.query(anyApi.public.getUserByEmail, {
    email: "nonexistent@example.com",
  });
  expect(user).toBeNull();
});

test("get user by email returns correct user", async () => {
  // Load test data
  const testUsers = [
    { email: "alice@example.com", name: "Alice", age: 25 },
    { email: "bob@example.com", name: "Bob", age: 30 },
    { email: "charlie@example.com", name: "Charlie", age: 35 },
  ];
  await addDocuments(responseAdminClient, "users", testUsers);

  // Test finding each user
  for (const testUser of testUsers) {
    const user = await responseClient.query(anyApi.public.getUserByEmail, {
      email: testUser.email,
    });

    // Verify user is found
    expect(user).toBeDefined();
    expect(user).not.toBeNull();

    // Verify all fields are present
    expect(user).toHaveProperty("_id");
    expect(user).toHaveProperty("_creationTime");
    expect(user).toHaveProperty("email", testUser.email);
    expect(user).toHaveProperty("name", testUser.name);
    expect(user).toHaveProperty("age", testUser.age);
  }
});

test("get user by email throws error for duplicate emails", async () => {
  // Load test data with duplicate email
  const testUsers = [
    { email: "duplicate@example.com", name: "User 1", age: 25 },
    { email: "duplicate@example.com", name: "User 2", age: 30 },
  ];
  await addDocuments(responseAdminClient, "users", testUsers);

  // Verify query throws error
  let error: any = undefined;
  try {
    await responseClient.query(anyApi.public.getUserByEmail, {
      email: "duplicate@example.com",
    });
  } catch (e) {
    error = e;
  }
  expect(error).toBeDefined();
});
