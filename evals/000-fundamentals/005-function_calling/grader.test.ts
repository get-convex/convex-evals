import { expect, test } from "vitest";
import {
  responseAdminClient,
  responseClient,
  compareSchema,
  compareFunctionSpec,
} from "../../../grader";
import { anyApi } from "convex/server";

test("compare schema", async ({ skip }) => {
  await compareSchema(skip);
});

test("compare function spec", async ({ skip }) => {
  await compareFunctionSpec(skip);
});

test("callerMutation chains calls correctly", async () => {
  const result = await responseAdminClient.mutation(
    anyApi.index.callerMutation,
    {},
  );
  // calleeQuery(1,2) = 3
  // calleeMutation(3,2) = 1
  expect(result).toBe(1);

  // Test with invalid arguments
  let error: any = undefined;
  try {
    await responseAdminClient.mutation(anyApi.index.callerMutation, { x: 1 });
  } catch (e) {
    error = e;
  }
  expect(error).toBeDefined();
  expect(error.toString()).toContain("ArgumentValidationError");
});

test("callerAction chains calls correctly", async () => {
  const result = await responseAdminClient.action(
    anyApi.index.callerAction,
    {},
  );
  // calleeQuery(1,2) = 3
  // calleeMutation(3,2) = 1
  // calleeAction(1,2) = 2
  expect(result).toBe(2);

  // Test with invalid arguments
  let error: any = undefined;
  try {
    await responseAdminClient.action(anyApi.index.callerAction, { x: 1 });
  } catch (e) {
    error = e;
  }
  expect(error).toBeDefined();
  expect(error.toString()).toContain("ArgumentValidationError");
});

test("internal functions work correctly", async () => {
  // Test calleeQuery
  const queryResult = await responseAdminClient.query(
    anyApi.index.calleeQuery,
    { x: 5, y: 3 },
  );
  expect(queryResult).toBe(8);

  // Test calleeMutation
  const mutationResult = await responseAdminClient.mutation(
    anyApi.index.calleeMutation,
    { x: 5, y: 3 },
  );
  expect(mutationResult).toBe(2);

  // Test calleeAction
  const actionResult = await responseAdminClient.action(
    anyApi.index.calleeAction,
    { x: 5, y: 3 },
  );
  expect(actionResult).toBe(15);

  // Test argument validation
  let error: any = undefined;
  try {
    await responseAdminClient.query(anyApi.index.calleeQuery, {
      x: "not a number",
      y: 3,
    });
  } catch (e) {
    error = e;
  }
  expect(error).toBeDefined();
  expect(error.toString()).toContain("ArgumentValidationError");
});

test("functions are not accessible from wrong client type", async () => {
  let error: any = undefined;

  // Query should not be callable as mutation
  try {
    await responseAdminClient.mutation(anyApi.index.calleeQuery, {
      x: 1,
      y: 2,
    });
  } catch (e) {
    error = e;
  }
  expect(error).toBeDefined();

  // Mutation should not be callable as action
  error = undefined;
  try {
    await responseAdminClient.action(anyApi.index.calleeMutation, {
      x: 1,
      y: 2,
    });
  } catch (e) {
    error = e;
  }
  expect(error).toBeDefined();

  // Action should not be callable as query
  error = undefined;
  try {
    await responseAdminClient.query(anyApi.index.calleeAction, { x: 1, y: 2 });
  } catch (e) {
    error = e;
  }
  expect(error).toBeDefined();
});
