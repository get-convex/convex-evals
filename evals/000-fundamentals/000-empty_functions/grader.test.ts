import { expect, test } from "vitest";
import {
  compareFunctionSpec,
  responseAdminClient,
  responseClient,
} from "../../../grader";
import { api, internal } from "./answer/convex/_generated/api";

test("compare function spec", async ({ skip }) => {
  await compareFunctionSpec(skip, { ignoreReturns: true });
});

test("empty public query", async () => {
  expect(await responseClient.query(api.index.emptyPublicQuery, {})).toBe(null);

  await expect(
    responseClient.query(api.index.emptyPublicQuery, { arg: "test" }),
  ).rejects.toThrow(/ArgumentValidationError/);
});

test("empty public mutation", async () => {
  expect(await responseClient.mutation(api.index.emptyPublicMutation, {})).toBe(
    null,
  );

  await expect(
    responseClient.mutation(api.index.emptyPublicMutation, {
      arg: "test",
    }),
  ).rejects.toThrow(/ArgumentValidationError/);
});

test("empty public action", async () => {
  expect(await responseClient.action(api.index.emptyPublicAction, {})).toBe(
    null,
  );

  await expect(
    responseClient.action(api.index.emptyPublicAction, { arg: "test" }),
  ).rejects.toThrow(/ArgumentValidationError/);
});

test("empty private query", async () => {
  expect(
    await responseAdminClient.query(
      internal.index.emptyPrivateQuery as any,
      {},
    ),
  ).toBe(null);
});

test("empty private mutation", async () => {
  expect(
    await responseAdminClient.mutation(
      internal.index.emptyPrivateMutation as any,
      {},
    ),
  ).toBe(null);
});

test("empty private action", async () => {
  expect(
    await responseAdminClient.action(
      internal.index.emptyPrivateAction as any,
      {},
    ),
  ).toBe(null);
});
