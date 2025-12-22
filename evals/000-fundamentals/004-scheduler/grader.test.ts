import { expect, test } from "vitest";
import { responseClient, responseAdminClient } from "../../../grader";
import { anyApi } from "convex/server";

test("callerMutation schedules tasks and returns null", async () => {
  expect(await responseClient.mutation(anyApi.index.callerMutation, {})).toBe(
    null,
  );
  await expect(
    responseClient.mutation(anyApi.index.callerMutation, { extra: true }),
  ).rejects.toThrow(/ArgumentValidationError/);
});

test("callerAction schedules tasks and returns null", async () => {
  expect(await responseClient.action(anyApi.index.callerAction, {})).toBe(null);
  await expect(
    responseClient.action(anyApi.index.callerAction, { extra: true }),
  ).rejects.toThrow(/ArgumentValidationError/);
});

test("internal logMutation returns null and is private", async () => {
  expect(
    await responseAdminClient.mutation(anyApi.index.logMutation, {
      message: "Hello, world!",
    }),
  ).toBe(null);

  await expect(
    responseClient.mutation(anyApi.index.logMutation, {
      message: "Hello, world!",
    }),
  ).rejects.toThrow(/Could not find public function/);

  await expect(
    responseAdminClient.mutation(anyApi.index.logMutation, {
      message: 123 as unknown as string,
    }),
  ).rejects.toThrow(/ArgumentValidationError/);
});

test("internal logAction returns null and is private", async () => {
  expect(
    await responseAdminClient.action(anyApi.index.logAction, {
      message: "Hello, world!",
    }),
  ).toBe(null);

  await expect(
    responseClient.action(anyApi.index.logAction, {
      message: "Hello, world!",
    }),
  ).rejects.toThrow(/Could not find public function/);

  await expect(
    responseAdminClient.action(anyApi.index.logAction, {
      message: 123 as unknown as string,
    }),
  ).rejects.toThrow(/ArgumentValidationError/);
});
