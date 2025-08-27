import { expect, test } from "vitest";
import { responseAdminClient, responseClient } from "../../../grader";
import { api } from "./answer/convex/_generated/api";

test("callerMutation chains calls correctly", async () => {
  const result = await responseAdminClient.mutation(
    api.index.callerMutation,
    {},
  );
  // calleeQuery(1,2) = 3
  // calleeMutation(3,2) = 1
  expect(result).toBe(1);

  // Test with invalid arguments
  await expect(
    responseAdminClient.mutation(api.index.callerMutation, { x: 1 } as any),
  ).rejects.toThrow(/ArgumentValidationError/);
});

test("callerAction chains calls correctly", async () => {
  const result = await responseAdminClient.action(api.index.callerAction, {});
  // calleeQuery(1,2) = 3
  // calleeMutation(3,2) = 1
  // calleeAction(1,2) = 2
  expect(result).toBe(2);

  // Test with invalid arguments
  await expect(
    responseAdminClient.action(api.index.callerAction, { x: 1 } as any),
  ).rejects.toThrow(/ArgumentValidationError/);
});

test("internal functions work correctly", async () => {
  // Test calleeQuery
  const queryResult = await responseAdminClient.query(
    // @ts-ignore
    api.index.calleeQuery,
    {
      x: 5,
      y: 3,
    },
  );
  expect(queryResult).toBe(8);

  // Test calleeMutation

  const mutationResult = await responseAdminClient.mutation(
    // @ts-ignore
    api.index.calleeMutation,
    { x: 5, y: 3 },
  );
  expect(mutationResult).toBe(2);

  // Test calleeAction
  // @ts-ignore
  const actionResult = await responseAdminClient.action(
    // @ts-ignore
    api.index.calleeAction,
    { x: 5, y: 3 },
  );
  expect(actionResult).toBe(15);

  // Test argument validation
  await expect(
    // @ts-ignore
    responseAdminClient.query(api.index.calleeQuery, {
      x: "not a number",
      y: 3,
    })
  ).rejects.toThrow(/ArgumentValidationError/);
});

test("functions are not accessible from wrong client type", async () => {
  let error: any = undefined;

  // Query should not be callable as mutation
  try {
    // @ts-ignore
    await responseAdminClient.mutation(api.index.calleeQuery, {
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
    // @ts-ignore
    await responseAdminClient.action(api.index.calleeMutation, {
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
    // @ts-ignore
    await responseAdminClient.query(api.index.calleeAction, { x: 1, y: 2 });
  } catch (e) {
    error = e;
  }
  expect(error).toBeDefined();
});
