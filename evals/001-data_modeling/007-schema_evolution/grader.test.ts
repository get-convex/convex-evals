import { expect, test } from "vitest";
import {
  responseAdminClient,
  responseClient,
  addDocuments,
  listTable,
} from "../../../grader";
import { api, internal } from "./answer/convex/_generated/api";
import { Doc } from "./answer/convex/_generated/dataModel";

import { createAIGraderTest } from "../../../grader/aiGrader";

createAIGraderTest(import.meta.url);

test("migration helper transforms data correctly", async () => {
  // Insert a product with old schema format
  await addDocuments(responseAdminClient, "products", [
    {
      name: "Test Product",
      category: "Test Category",
      active: true,
    },
  ]);

  const products = await listTable(responseAdminClient, "products");
  const productId = (products.at(-1) as Doc<"products">)._id;

  // Test migration mutation
  await responseClient.mutation(api.index.migrateProduct, { productId });

  // Test that the product was migrated correctly
  const product = await responseClient.query(api.index.getProduct, {
    productId,
  });
  expect(product).toMatchObject({
    _id: productId,
    _creationTime: expect.any(Number),
    name: "Test Product",
    description: "No description",
    active: "active",
  });
});
