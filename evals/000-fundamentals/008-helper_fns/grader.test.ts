import { expect, test } from "vitest";
import {
  responseAdminClient,
  responseClient,
  addDocuments,
  listTable,
} from "../../../grader";
import { api } from "./answer/convex/_generated/api";
import { Doc, Id } from "./answer/convex/_generated/dataModel";
import { createAIGraderTest } from "../../../grader/aiGrader";

createAIGraderTest(import.meta.url);

test("getItem and updateItem handle non-existent items", async () => {
  // Try to get a non-existent item
  let error = null;
  try {
    await responseClient.query(api.index.getItem, {
      itemId: "items:nonexistent" as Id<"items">,
    });
  } catch (e) {
    error = e;
  }
  expect(error).toBeDefined();

  // Try to update a non-existent item
  error = null;
  try {
    await responseClient.mutation(api.index.updateItem, {
      itemId: "items:nonexistent" as Id<"items">,
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
  const itemId = (documents.at(-1) as Doc<"items">)._id;

  // Get the item
  const item = await responseClient.query(api.index.getItem, {
    itemId,
  });

  // Verify item format
  expect(item).toHaveProperty("name", "Test Item");
  expect(item).toHaveProperty("quantity", 5);
  expect(item).toHaveProperty("lastModified");
  expect(item.lastModified).toBeTypeOf("string");

  // Update the item
  await responseClient.mutation(api.index.updateItem, {
    itemId,
    quantity: 10,
  });

  // Get the updated item
  const updatedItem = await responseClient.query(api.index.getItem, {
    itemId,
  });

  // Verify the update
  expect(updatedItem.quantity).toBe(10);
  expect(new Date(updatedItem.lastModified).getTime()).toBeGreaterThan(
    new Date(item.lastModified).getTime(),
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
  const itemId = (documents.at(-1) as Doc<"items">)._id;

  // Update the item
  const updatedItem = await responseClient.mutation(api.index.updateItem, {
    itemId,
    quantity: 10,
  });

  // Get the updated item
  const item = await responseClient.query(api.index.getItem, {
    itemId,
  });

  // Verify the update
  expect(updatedItem).toEqual(item);
});
