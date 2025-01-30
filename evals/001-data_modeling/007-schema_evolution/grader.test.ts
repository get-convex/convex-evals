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

test("compare schema", async ({ skip }) => {
  await compareSchema(skip);
});

test("compare function spec", async ({ skip }) => {
  await compareFunctionSpec(skip);
});

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
  const productId = (products.at(-1))._id;

  // Test migration mutation
  await responseClient.mutation(anyApi.index.migrateProduct, { productId });

  // Test that the product was migrated correctly
  const product = await responseClient.query(anyApi.index.getProduct, {
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
