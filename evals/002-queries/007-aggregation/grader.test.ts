import { expect, test } from "vitest";
import {
  responseAdminClient,
  responseClient,
  compareSchema,
  addDocuments,
} from "../../../grader";
import { anyApi } from "convex/server";
import { createAIGraderTest } from "../../../grader/aiGrader";

createAIGraderTest(import.meta.url);

test("compare schema", async ({ skip }) => {
  await compareSchema(skip);
});

test("get customer stats returns zeros when no orders exist", async () => {
  const stats = await responseClient.query(anyApi.public.getCustomerStats, {
    customerId: "customer1",
  });
  expect(stats).toEqual({
    totalOrders: 0,
    totalItems: 0,
    totalSpent: 0.0,
    averageOrderValue: 0.0,
  });
});

test("get customer stats calculates correct statistics", async () => {
  // Load test data with multiple orders
  const testOrders = [
    // Customer 1 orders
    {
      customerId: "customer1",
      productId: "product1",
      quantity: 2,
      pricePerUnit: 10.99,
    },
    {
      customerId: "customer1",
      productId: "product2",
      quantity: 1,
      pricePerUnit: 25.5,
    },
    {
      customerId: "customer1",
      productId: "product1",
      quantity: 3,
      pricePerUnit: 10.99,
    },

    // Customer 2 orders
    {
      customerId: "customer2",
      productId: "product1",
      quantity: 1,
      pricePerUnit: 10.99,
    },
  ];
  await addDocuments(responseAdminClient, "orders", testOrders);

  // Test stats for customer1
  const customer1Stats = await responseClient.query(
    anyApi.public.getCustomerStats,
    {
      customerId: "customer1",
    },
  );

  // Verify calculations
  // Order 1: 2 * 10.99 = 21.98
  // Order 2: 1 * 25.50 = 25.50
  // Order 3: 3 * 10.99 = 32.97
  // Total spent: 80.45
  // Total items: 6
  // Average order value: 80.45 / 3 = 26.82
  expect(customer1Stats).toEqual({
    totalOrders: 3,
    totalItems: 6,
    totalSpent: 80.45,
    averageOrderValue: 26.82,
  });

  // Test stats for customer2
  const customer2Stats = await responseClient.query(
    anyApi.public.getCustomerStats,
    {
      customerId: "customer2",
    },
  );

  // Verify calculations
  // Order 1: 1 * 10.99 = 10.99
  expect(customer2Stats).toEqual({
    totalOrders: 1,
    totalItems: 1,
    totalSpent: 10.99,
    averageOrderValue: 10.99,
  });
});

test("get customer stats handles fractional numbers correctly", async () => {
  // Load test data with fractional quantities and prices
  const testOrders = [
    {
      customerId: "customer3",
      productId: "product1",
      quantity: 1.5,
      pricePerUnit: 10.33,
    },
    {
      customerId: "customer3",
      productId: "product2",
      quantity: 2.25,
      pricePerUnit: 15.67,
    },
  ];
  await addDocuments(responseAdminClient, "orders", testOrders);

  const stats = await responseClient.query(anyApi.public.getCustomerStats, {
    customerId: "customer3",
  });

  // Verify calculations with proper rounding
  // Order 1: 1.5 * 10.33 = 15.495
  // Order 2: 2.25 * 15.67 = 35.2575
  // Total spent: 50.75 (rounded to 2 decimals)
  // Total items: 3.75
  // Average order value: 25.38 (rounded to 2 decimals)
  expect(stats).toEqual({
    totalOrders: 2,
    totalItems: 3.75,
    totalSpent: 50.75,
    averageOrderValue: 25.38,
  });
});
