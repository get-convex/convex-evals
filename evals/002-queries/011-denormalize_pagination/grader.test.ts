import { expect, test } from "vitest";
import {
  responseAdminClient,
  responseClient,
  compareSchema,
  addDocuments,
  listTable,
  deleteAllDocuments,
} from "../../../grader";
import { api } from "./answer/convex/_generated/api";
import { Doc } from "./answer/convex/_generated/dataModel";
import { beforeEach } from "vitest";
import { createAIGraderTest } from "../../../grader/aiGrader";

createAIGraderTest(import.meta.url);

beforeEach(async () => {
  await deleteAllDocuments(responseAdminClient, ["dogs", "owners"]);
});

test("compare schema", async ({ skip }) => {
  await compareSchema(skip);
});

test("paginateDogsByOwnerAge returns correct pagination", async () => {
  await deleteAllDocuments(responseAdminClient, ["dogs", "owners"]);
  // Create owners with different ages
  await addDocuments(responseAdminClient, "owners", [
    {
      name: "Young",
      age: 20,
    },
    {
      name: "Older",
      age: 90,
    },
  ]);
  const owners = (await listTable(
    responseAdminClient,
    "owners",
  )) as Doc<"owners">[];
  const [owner1Id, owner2Id] = owners.slice(-2).map((o) => o._id);

  await addDocuments(responseAdminClient, "dogs", [
    {
      name: "Young Dog 1",
      breed: "Breed1",
      ownerId: owner1Id,
      ownerAge: 20,
    },
    {
      name: "Old Dog",
      breed: "Breed3",
      ownerId: owner2Id,
      ownerAge: 90,
    },
    {
      name: "Young Dog 2",
      breed: "Breed2",
      ownerId: owner1Id,
      ownerAge: 20,
    },
  ]);

  // Test pagination
  const firstPage = await responseClient.query(
    api.index.paginateDogsByOwnerAge,
    {
      cursor: null,
      numItems: 2,
    },
  );

  expect(firstPage.dogs).toHaveLength(2);
  expect(firstPage.continueCursor).toBeDefined();
  expect(firstPage.dogs.map((d) => d.name)).toEqual([
    "Young Dog 1",
    "Young Dog 2",
  ]);

  const secondPage = await responseClient.query(
    api.index.paginateDogsByOwnerAge,
    {
      cursor: firstPage.continueCursor,
      numItems: 2,
    },
  );

  expect(secondPage.dogs).toHaveLength(1);
  expect(secondPage.continueCursor).toBeDefined();
  expect(secondPage.dogs.map((d) => d.name)).toEqual(["Old Dog"]);
});

test("paginateDogsByOwnerAge returns correct page sizes", async () => {
  // Create owners with different ages
  await addDocuments(responseAdminClient, "owners", [
    { name: "Young", age: 25 },
    { name: "Middle", age: 35 },
    { name: "Old", age: 45 },
  ]);
  const owners = (await listTable(
    responseAdminClient,
    "owners",
  )) as Doc<"owners">[];
  const [young, middle, old] = owners.slice(-3).map((o) => o._id);

  // Create dogs for each owner
  await addDocuments(responseAdminClient, "dogs", [
    { name: "Dog1", breed: "Breed1", ownerId: young, ownerAge: 25 },
    { name: "Dog2", breed: "Breed2", ownerId: middle, ownerAge: 35 },
    { name: "Dog3", breed: "Breed3", ownerId: old, ownerAge: 45 },
    { name: "Dog4", breed: "Breed4", ownerId: young, ownerAge: 25 },
    { name: "Dog5", breed: "Breed5", ownerId: middle, ownerAge: 35 },
  ]);

  // Test pagination with different page sizes
  const page1 = await responseClient.query(api.index.paginateDogsByOwnerAge, {
    cursor: null,
    numItems: 2,
  });
  expect(page1.dogs).toHaveLength(2);
  expect(page1.continueCursor).toBeDefined();

  const page2 = await responseClient.query(api.index.paginateDogsByOwnerAge, {
    cursor: page1.continueCursor,
    numItems: 2,
  });
  expect(page2.dogs).toHaveLength(2);
  expect(page2.continueCursor).toBeDefined();

  const page3 = await responseClient.query(api.index.paginateDogsByOwnerAge, {
    cursor: page2.continueCursor,
    numItems: 2,
  });
  expect(page3.dogs).toHaveLength(1); // Last page should have remaining item
  expect(page3.continueCursor).toBeDefined();
});

test("paginateDogsByOwnerAge returns dogs ordered by owner age", async () => {
  // Create owners with different ages
  await addDocuments(responseAdminClient, "owners", [
    { name: "Old", age: 60 },
    { name: "Young", age: 20 },
    { name: "Middle", age: 40 },
  ]);
  const owners = (await listTable(
    responseAdminClient,
    "owners",
  )) as Doc<"owners">[];
  const [old, young, middle] = owners.slice(-3).map((o) => o._id);

  // Create dogs for each owner (in mixed order)
  await addDocuments(responseAdminClient, "dogs", [
    { name: "OldDog", breed: "Breed1", ownerId: old, ownerAge: 60 },
    { name: "YoungDog", breed: "Breed2", ownerId: young, ownerAge: 20 },
    { name: "MiddleDog", breed: "Breed3", ownerId: middle, ownerAge: 40 },
  ]);

  // Get all dogs in one page
  const result = await responseClient.query(api.index.paginateDogsByOwnerAge, {
    cursor: null,
    numItems: 10,
  });

  // Verify dogs are ordered by owner age
  const dogNames = result.dogs.map((d) => d.name);
  expect(dogNames).toEqual(["YoungDog", "MiddleDog", "OldDog"]);
});

test("paginateDogsByOwnerAge handles empty results", async () => {
  const result = await responseClient.query(api.index.paginateDogsByOwnerAge, {
    cursor: null,
    numItems: 5,
  });

  expect(result.dogs).toHaveLength(0);
  expect(result.continueCursor).toBeDefined();
});

test("paginateDogsByOwnerAge returns correct dog fields", async () => {
  // Create one owner and dog
  await addDocuments(responseAdminClient, "owners", [
    { name: "Owner", age: 30 },
  ]);
  const owner = (await listTable(responseAdminClient, "owners")).at(
    -1,
  ) as Doc<"owners">;

  await addDocuments(responseAdminClient, "dogs", [
    {
      name: "TestDog",
      breed: "TestBreed",
      ownerId: owner._id,
      ownerAge: 30,
    },
  ]);

  const result = await responseClient.query(api.index.paginateDogsByOwnerAge, {
    cursor: null,
    numItems: 1,
  });

  expect(result.dogs[0]).toEqual({
    name: "TestDog",
    breed: "TestBreed",
  });
});
