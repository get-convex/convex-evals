import { afterEach, expect, test } from "vitest";
import {
  responseAdminClient,
  responseClient,
  compareSchema,
  addDocuments,
  deleteAllDocuments,
} from "../../../grader";
import { api } from "./answer/convex/_generated/api";
import { createAIGraderTest } from "../../../grader/aiGrader";

createAIGraderTest(import.meta.url);

afterEach(async () => {
  await deleteAllDocuments(responseAdminClient, ["users"]);
});

test("compare schema", async ({ skip }) => {
  await compareSchema(skip);
});

test("getActiveAdults returns empty array when no matching users exist", async () => {
  const users = await responseClient.query(api.index.getActiveAdults, {
    minAge: 18,
  });
  expect(users).toEqual([]);
});

test("getActiveAdults correctly filters by age and deleted status", async () => {
  // Add test users with various ages and deletion states
  const testUsers = [
    { name: "Teen", age: 16, isDeleted: false },
    { name: "Young Adult", age: 21, isDeleted: false },
    { name: "Adult", age: 30, isDeleted: false },
    { name: "Deleted Adult", age: 25, isDeleted: true },
    { name: "Senior", age: 65, isDeleted: false },
  ];
  await addDocuments(responseAdminClient, "users", testUsers);

  // Test filtering adults (18+)
  const adults = await responseClient.query(api.index.getActiveAdults, {
    minAge: 18,
  });

  // Should include active adults but exclude teens and deleted users
  expect(adults).toEqual(["Young Adult", "Adult", "Senior"]);

  // Test filtering seniors (65+)
  const seniors = await responseClient.query(api.index.getActiveAdults, {
    minAge: 65,
  });

  // Should only include active seniors
  expect(seniors).toEqual(["Senior"]);
});

test("getActiveAdults handles edge cases", async () => {
  // Add edge case users
  const edgeCaseUsers = [
    { name: "Exactly18", age: 18, isDeleted: false },
    { name: "Exactly18Deleted", age: 18, isDeleted: true },
    { name: "VeryOld", age: 100, isDeleted: false },
  ];
  await addDocuments(responseAdminClient, "users", edgeCaseUsers);

  // Test exact age boundary
  const exactlyEighteen = await responseClient.query(
    api.index.getActiveAdults,
    {
      minAge: 18,
    },
  );
  expect(exactlyEighteen).toContain("Exactly18");
  expect(exactlyEighteen).not.toContain("Exactly18Deleted");

  // Test high age
  const veryOld = await responseClient.query(api.index.getActiveAdults, {
    minAge: 90,
  });
  expect(veryOld).toEqual(["VeryOld"]);

  // Test age with no possible matches
  const impossibleAge = await responseClient.query(api.index.getActiveAdults, {
    minAge: 200,
  });
  expect(impossibleAge).toEqual([]);
});

test("getActiveAdults returns results in consistent order", async () => {
  // Clear existing users
  await addDocuments(responseAdminClient, "users", [
    { name: "Alice", age: 25, isDeleted: false },
    { name: "Bob", age: 30, isDeleted: false },
    { name: "Charlie", age: 35, isDeleted: false },
  ]);

  // Query multiple times to verify consistent ordering
  const results1 = await responseClient.query(api.index.getActiveAdults, {
    minAge: 20,
  });
  const results2 = await responseClient.query(api.index.getActiveAdults, {
    minAge: 20,
  });

  expect(results1).toEqual(results2);
  expect(results1.length).toBe(3);
});

test("getActiveAdults handles negative ages", async () => {
  await addDocuments(responseAdminClient, "users", [
    { name: "Invalid", age: -5, isDeleted: false },
    { name: "Valid", age: 20, isDeleted: false },
  ]);

  const results = await responseClient.query(api.index.getActiveAdults, {
    minAge: -10,
  });

  expect(results).toContain("Invalid");
  expect(results).toContain("Valid");
});
