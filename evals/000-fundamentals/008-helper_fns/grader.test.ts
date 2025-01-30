import { expect, test } from "vitest";
import {
  responseAdminClient,
  responseClient,
  compareSchema,
  compareFunctionSpec,
  addDocuments,
  listTable,
} from "../../../grader";
import { anyApi } from "convex/server";
import { GenericId } from "convex/values";

test("compare schema", async ({ skip }) => {
  await compareSchema(skip);
});

test("compare function spec", async ({ skip }) => {
  await compareFunctionSpec(skip);
});

test("getItem and updateItem handle non-existent items", async () => {
  // Try to get a non-existent item
  let error = null;
  try {
    await responseClient.query(anyApi.index.getItem, {
      id: "items:nonexistent" as GenericId<"items">,
    });
  } catch (e) {
    error = e;
  }
  expect(error).toBeDefined();

  // Try to update a non-existent item
  error = null;
  try {
    await responseClient.mutation(anyApi.index.updateItem, {
      id: "items:nonexistent" as GenericId<"items">,
      quantity: 10,
    });
  } catch (e) {
    error = e;
  }
  expect(error).toBeDefined();
});

test("getItem and updateItem work correctly with existing items", async () => {
  // Create a test item
  await addDocuments(responseAdminClient, "items", [
    {
      name: "Test Item",
      quantity: 5,
      lastModified: Date.now(),
    },
  ]);
  const documents = await listTable(responseAdminClient, "items");
  const itemId = (documents.at(-1))._id;

  // Get the item
  const item = await responseClient.query(anyApi.index.getItem, {
    id: itemId,
  });

  // Verify item format
  expect(item).toHaveProperty("name", "Test Item");
  expect(item).toHaveProperty("quantity", 5);
  expect(item).toHaveProperty("lastModified");
  expect(item.lastModified).toBeTypeOf("string");

  // Update the item
  await responseClient.mutation(anyApi.index.updateItem, {
    id: itemId,
    quantity: 10,
  });

  // Get the updated item
  const updatedItem = await responseClient.query(anyApi.index.getItem, {
    id: itemId,
  });

  // Verify the update
  expect(updatedItem.quantity).toBe(10);
  expect(new Date(updatedItem.lastModified).getTime()).toBeGreaterThan(
    new Date(item.lastModified).getTime()
  );
});

test("getItem and updateItem return the same format", async () => {
  // Create a test item
  await addDocuments(responseAdminClient, "items", [
    {
      name: "Test Item",
      quantity: 5,
      lastModified: Date.now(),
    },
  ]);
  const documents = await listTable(responseAdminClient, "items");
  const itemId = (documents.at(-1))._id;

  // Update the item
  const updatedItem = await responseClient.mutation(anyApi.index.updateItem, {
    id: itemId,
    quantity: 10,
  });

  // Get the updated item
  const item = await responseClient.query(anyApi.index.getItem, {
    id: itemId,
  });

  // Verify the update
  expect(updatedItem).toEqual(item);
});
