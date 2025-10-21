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

test("get all products returns empty list when no products exist", async () => {
  const products = await responseClient.query(anyApi.public.getAllProducts, {});
  expect(products).toEqual([]);
});

test("get all products returns all products in the table", async () => {
  // Load test data
  const testProducts = [
    { name: "Apple", price: 1.99, inStock: true },
    { name: "Banana", price: 0.99, inStock: true },
    { name: "Orange", price: 2.49, inStock: false },
    { name: "Mango", price: 3.99, inStock: true },
  ];
  await addDocuments(responseAdminClient, "products", testProducts);

  // Query all products
  const products = await responseClient.query(anyApi.public.getAllProducts, {});

  // Verify all products are returned
  expect(products).toHaveLength(testProducts.length);

  // Verify each product has the correct fields
  for (const product of products) {
    expect(product).toHaveProperty("_id");
    expect(product).toHaveProperty("_creationTime");
    expect(product).toHaveProperty("name");
    expect(product).toHaveProperty("price");
    expect(product).toHaveProperty("inStock");
  }

  // Verify the data matches our test data
  const sortedProducts = products
    .map(
      (p: {
        name: string;
        price: number;
        inStock: boolean;
        _id: string;
        _creationTime: number;
      }) => ({ name: p.name, price: p.price, inStock: p.inStock }),
    )
    .sort((a: { name: string }, b: { name: string }) =>
      a.name.localeCompare(b.name),
    );
  const sortedTestProducts = [...testProducts].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  expect(sortedProducts).toEqual(sortedTestProducts);
});
