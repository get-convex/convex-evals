import { expect, test } from "vitest";
import { responseAdminClient, responseClient } from "../../../grader";
import { anyApi } from "convex/server";

test("empty public query", async () => {
  expect(await responseClient.query(anyApi.index.emptyPublicQuery, {})).toBe(
    null,
  );

  await expect(
    responseClient.query(anyApi.index.emptyPublicQuery, { arg: "test" }),
  ).rejects.toThrow(/ArgumentValidationError/);

  await expect(
    responseClient.mutation(anyApi.index.emptyPublicQuery, {}),
  ).rejects.toBeDefined();

  await expect(
    responseClient.action(anyApi.index.emptyPublicQuery, {}),
  ).rejects.toBeDefined();
});

test("empty public mutation", async () => {
  expect(
    await responseClient.mutation(anyApi.index.emptyPublicMutation, {}),
  ).toBe(null);

  await expect(
    responseClient.mutation(anyApi.index.emptyPublicMutation, {
      arg: "test",
    }),
  ).rejects.toThrow(/ArgumentValidationError/);

  await expect(
    responseClient.query(anyApi.index.emptyPublicMutation, {}),
  ).rejects.toBeDefined();

  await expect(
    responseClient.action(anyApi.index.emptyPublicMutation, {}),
  ).rejects.toBeDefined();
});

test("empty public action", async () => {
  expect(await responseClient.action(anyApi.index.emptyPublicAction, {})).toBe(
    null,
  );

  await expect(
    responseClient.action(anyApi.index.emptyPublicAction, { arg: "test" }),
  ).rejects.toThrow(/ArgumentValidationError/);

  await expect(
    responseClient.query(anyApi.index.emptyPublicAction, {}),
  ).rejects.toBeDefined();

  await expect(
    responseClient.mutation(anyApi.index.emptyPublicAction, {}),
  ).rejects.toBeDefined();
});

test("empty private query", async () => {
  await expect(
    responseClient.query(anyApi.index.emptyPrivateQuery, {}),
  ).rejects.toThrow(/Could not find public function/);

  expect(
    await responseAdminClient.query(anyApi.index.emptyPrivateQuery, {}),
  ).toBe(null);
});

test("empty private mutation", async () => {
  await expect(
    responseClient.mutation(anyApi.index.emptyPrivateMutation, {}),
  ).rejects.toThrow(/Could not find public function/);

  expect(
    await responseAdminClient.mutation(anyApi.index.emptyPrivateMutation, {}),
  ).toBe(null);
});

test("empty private action", async () => {
  await expect(
    responseClient.action(anyApi.index.emptyPrivateAction, {}),
  ).rejects.toThrow(/Could not find public function/);

  expect(
    await responseAdminClient.action(anyApi.index.emptyPrivateAction, {}),
  ).toBe(null);
});
