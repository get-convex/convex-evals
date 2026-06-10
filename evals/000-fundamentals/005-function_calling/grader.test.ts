import { expect, test } from "vitest";
import {
  compareFunctionSpec,
  responseAdminClient,
} from "../../../grader";
import { api } from "./answer/convex/_generated/api";

test("compare function spec", async ({ skip }) => {
  await compareFunctionSpec(skip);
});

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
