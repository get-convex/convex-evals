import { expect, test } from "vitest";
import { responseClient, responseAdminClient } from "../../../grader";
import { api, internal } from "./answer/convex/_generated/api";

test("callerMutation schedules tasks and returns null", async () => {
  expect(await responseClient.mutation(api.index.callerMutation, {})).toBe(
    null,
  );
  await expect(
    responseClient.mutation(api.index.callerMutation, { extra: true }),
  ).rejects.toThrow(/ArgumentValidationError/);
});

test("callerAction schedules tasks and returns null", async () => {
  expect(await responseClient.action(api.index.callerAction, {})).toBe(null);
  await expect(
    responseClient.action(api.index.callerAction, { extra: true }),
  ).rejects.toThrow(/ArgumentValidationError/);
});

test("internal logMutation returns null and is private", async () => {
  expect(
    await responseAdminClient.mutation(internal.index.logMutation as any, {
      message: "Hello, world!",
    }),
  ).toBe(null);

  await expect(
    responseClient.mutation(internal.index.logMutation as any, {
      message: "Hello, world!",
    }),
  ).rejects.toThrow(/Could not find public function/);

  await expect(
    responseAdminClient.mutation(internal.index.logMutation as any, {
      message: 123 as unknown as string,
    }),
  ).rejects.toThrow(/ArgumentValidationError/);
});

test("internal logAction returns null and is private", async () => {
  expect(
    await responseAdminClient.action(internal.index.logAction as any, {
      message: "Hello, world!",
    }),
  ).toBe(null);

  await expect(
    responseClient.action(internal.index.logAction as any, {
      message: "Hello, world!",
    }),
  ).rejects.toThrow(/Could not find public function/);

  await expect(
    responseAdminClient.action(internal.index.logAction as any, {
      message: 123 as unknown as string,
    }),
  ).rejects.toThrow(/ArgumentValidationError/);
});
