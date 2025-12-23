import { expect, test } from "vitest";
import { responseAdminClient, responseClient } from "../../../grader";
import { api, internal } from "./answer/convex/_generated/api";

test("empty public query", async () => {
  expect(await responseClient.query(api.index.emptyPublicQuery, {})).toBe(null);

  await expect(
    responseClient.query(api.index.emptyPublicQuery, { arg: "test" }),
  ).rejects.toThrow(/ArgumentValidationError/);

  await expect(
    responseClient.mutation(api.index.emptyPublicQuery as any, {}),
  ).rejects.toBeDefined();

  await expect(
    responseClient.action(api.index.emptyPublicQuery as any, {}),
  ).rejects.toBeDefined();
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

  await expect(
    responseClient.query(api.index.emptyPublicMutation as any, {}),
  ).rejects.toBeDefined();

  await expect(
    responseClient.action(api.index.emptyPublicMutation as any, {}),
  ).rejects.toBeDefined();
});

test("empty public action", async () => {
  expect(await responseClient.action(api.index.emptyPublicAction, {})).toBe(
    null,
  );

  await expect(
    responseClient.action(api.index.emptyPublicAction, { arg: "test" }),
  ).rejects.toThrow(/ArgumentValidationError/);

  await expect(
    responseClient.query(api.index.emptyPublicAction as any, {}),
  ).rejects.toBeDefined();

  await expect(
    responseClient.mutation(api.index.emptyPublicAction as any, {}),
  ).rejects.toBeDefined();
});

test("empty private query", async () => {
  await expect(
    responseClient.query(internal.index.emptyPrivateQuery as any, {}),
  ).rejects.toThrow(/Could not find public function/);

  expect(
    await responseAdminClient.query(
      internal.index.emptyPrivateQuery as any,
      {},
    ),
  ).toBe(null);
});

test("empty private mutation", async () => {
  await expect(
    responseClient.mutation(internal.index.emptyPrivateMutation as any, {}),
  ).rejects.toThrow(/Could not find public function/);

  expect(
    await responseAdminClient.mutation(
      internal.index.emptyPrivateMutation as any,
      {},
    ),
  ).toBe(null);
});

test("empty private action", async () => {
  await expect(
    responseClient.action(internal.index.emptyPrivateAction as any, {}),
  ).rejects.toThrow(/Could not find public function/);

  expect(
    await responseAdminClient.action(
      internal.index.emptyPrivateAction as any,
      {},
    ),
  ).toBe(null);
});
