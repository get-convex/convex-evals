import { expect, test } from "vitest";
import {
  responseAdminClient,
  responseClient,
  compareSchema,
  addDocuments,
  deleteAllDocuments,
} from "../../../grader";
import { api } from "./answer/convex/_generated/api";
import { beforeEach } from "vitest";
import { createAIGraderTest } from "../../../grader/aiGrader";

createAIGraderTest(import.meta.url);

beforeEach(async () => {
  await deleteAllDocuments(responseAdminClient, ["users"]);
});

test("compare schema", async ({ skip }) => {
  await compareSchema(skip);
});

test("getDistinctAges returns empty array when no users exist", async () => {
  const ages = await responseClient.query(api.index.getDistinctAges, {});
  expect(ages).toEqual([]);
});

test("getDistinctAges returns single age when all users have same age", async () => {
  const users = [
    { name: "User1", age: 25 },
    { name: "User2", age: 25 },
    { name: "User3", age: 25 },
  ];
  await addDocuments(responseAdminClient, "users", users);

  const ages = await responseClient.query(api.index.getDistinctAges, {});
  expect(ages).toEqual([25]);
});

test("getDistinctAges returns sorted distinct ages", async () => {
  const users = [
    { name: "User1", age: 20 },
    { name: "User2", age: 30 },
    { name: "User3", age: 20 },
    { name: "User4", age: 25 },
    { name: "User5", age: 30 },
    { name: "User6", age: 25 },
  ];
  await addDocuments(responseAdminClient, "users", users);

  const ages = await responseClient.query(api.index.getDistinctAges, {});
  expect(ages).toEqual([20, 25, 30]);
});

test("getDistinctAges handles negative and zero ages", async () => {
  const users = [
    { name: "User1", age: -10 },
    { name: "User2", age: 0 },
    { name: "User3", age: -10 },
    { name: "User4", age: 10 },
    { name: "User5", age: 0 },
  ];
  await addDocuments(responseAdminClient, "users", users);

  const ages = await responseClient.query(api.index.getDistinctAges, {});
  expect(ages).toEqual([-10, 0, 10]);
});

test("getDistinctAges handles large age ranges", async () => {
  const users = [
    { name: "User1", age: 1 },
    { name: "User2", age: 50 },
    { name: "User3", age: 100 },
  ];
  await addDocuments(responseAdminClient, "users", users);

  const ages = await responseClient.query(api.index.getDistinctAges, {});
  expect(ages).toEqual([1, 50, 100]);
});

test("getDistinctAges maintains order with mixed insertions", async () => {
  // First batch
  await addDocuments(responseAdminClient, "users", [
    { name: "User1", age: 30 },
    { name: "User2", age: 20 },
  ]);

  // Second batch
  await addDocuments(responseAdminClient, "users", [
    { name: "User3", age: 25 },
    { name: "User4", age: 20 },
  ]);

  // Third batch
  await addDocuments(responseAdminClient, "users", [
    { name: "User5", age: 30 },
    { name: "User6", age: 22 },
  ]);

  const ages = await responseClient.query(api.index.getDistinctAges, {});
  expect(ages).toEqual([20, 22, 25, 30]);
});

test("getDistinctAges handles sparse age distribution", async () => {
  const users = [
    { name: "User1", age: 1 },
    { name: "User2", age: 1000 },
    { name: "User3", age: 1 },
    { name: "User4", age: 1000 },
    { name: "User5", age: 500 },
  ];
  await addDocuments(responseAdminClient, "users", users);

  const ages = await responseClient.query(api.index.getDistinctAges, {});
  expect(ages).toEqual([1, 500, 1000]);
});

// test("getDistinctAges handles large number of users", async () => {
//   // for (let i = 0; i < 10; i++) {
//     const users = Array.from({ length: 1000 }, (_, i) => ({ name: `User${i}`, age: i % 100 }));
//     await addDocuments(responseAdminClient, "users", users);
//   // }

//   const ages = await responseClient.query(api.index.getDistinctAges, {});
//   expect(ages).toEqual(Array.from({length: 100}, (_, i) => i));
// });
