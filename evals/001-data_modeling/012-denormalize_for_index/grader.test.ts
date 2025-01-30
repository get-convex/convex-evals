import { expect, test } from "vitest";
import {
  responseAdminClient,
  responseClient,
  compareSchema,
  compareFunctionSpec,
  addDocuments,
  listTable,
  deleteAllDocuments,
} from "../../../grader";
import { anyApi } from "convex/server";
import { beforeEach } from "node:test";

beforeEach(async () => {
  await deleteAllDocuments(responseAdminClient, ["dogs", "owners"]);
});

test("compare schema", async ({ skip }) => {
  await compareSchema(skip);
});

test("compare function spec", async ({ skip }) => {
  await compareFunctionSpec(skip);
});

test("createDog creates dog with denormalized owner data", async () => {
  // Create an owner
  await addDocuments(responseAdminClient, "owners", [{
    name: "John",
    age: 30,
  }]);
  const owners = await listTable(responseAdminClient, "owners");
  const ownerId = (owners.at(-1))._id;

  // Create a dog using the mutation
  const dogId = await responseClient.mutation(anyApi.index.createDog, {
    dogName: "Rover",
    breed: "Labrador",
    ownerId,
  });

  // Verify the dog was created with correct data
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const dogs = await listTable(responseAdminClient, "dogs");
  const dog = dogs.find(d => d._id === dogId);
  expect(dog).toMatchObject({
    _id: dogId,
    name: "Rover",
    breed: "Labrador",
    ownerId,
    ownerAge: 30,
  });
});

test("updateOwnerAge updates denormalized data", async () => {
  // Create owner and dogs
  await addDocuments(responseAdminClient, "owners", [{
    name: "Alice",
    age: 25,
  }]);
  const owner = (await listTable(responseAdminClient, "owners")).at(-1);
  expect(owner.age).toBe(25);
  const ownerId = owner._id;

  await responseClient.mutation(anyApi.index.createDog, {
    dogName: "Spot",
    breed: "Dalmatian",
    ownerId,
  });
  await responseClient.mutation(anyApi.index.createDog, {
    dogName: "Rex",
    breed: "German Shepherd",
    ownerId,
  });

  // Update owner's age
  await responseClient.mutation(anyApi.index.updateOwnerAge, {
    ownerId,
    newAge: 26,
  });

  // Verify all dogs were updated
  const dogs = (await listTable(responseAdminClient, "dogs"));
  const ownersDogs = dogs.filter(d => d.ownerId === ownerId);
  expect(ownersDogs).toHaveLength(2);
  ownersDogs.forEach(dog => {
    expect(dog.ownerAge).toBe(26);
  });
});

test("getDogsByOwnerAge returns dogs with the given owner age", async () => {
  await deleteAllDocuments(responseAdminClient, ["dogs", "owners"]);
  // Create owners with different ages
  await addDocuments(responseAdminClient, "owners", [{
    name: "Young",
    age: 20,
  }, {
    name: "Older",
    age: 90,
  }]);
  const owners = (await listTable(responseAdminClient, "owners"));
  const [owner1Id, owner2Id] = owners.slice(-2).map(o => o._id);

  // Create dogs for each owner
  await responseClient.mutation(anyApi.index.createDog, {
    dogName: "Young Dog 1",
    breed: "Breed1",
    ownerId: owner1Id,
  });

  await responseClient.mutation(anyApi.index.createDog, {
    dogName: "Old Dog",
    breed: "Breed3",
    ownerId: owner2Id,
  });

  await responseClient.mutation(anyApi.index.createDog, {
    dogName: "Young Dog 2",
    breed: "Breed2",
    ownerId: owner1Id,
  });

  // Test query
  const dogs = await responseClient.query(anyApi.index.getDogsByOwnerAge, {
    age: 20,
  });
  expect(dogs).toHaveLength(2);
  expect(dogs.map(d => d.name)).toEqual(["Young Dog 1", "Young Dog 2"]);

  // Test no dogs found
  const dogs2 = await responseClient.query(anyApi.index.getDogsByOwnerAge, {
    age: 45,
  });
  expect(dogs2).toHaveLength(0);
});
