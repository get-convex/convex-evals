import { expect, test, vi } from "vitest";
import {
  responseClient,
  responseAdminClient,
  compareFunctionSpec,
} from "../../../grader";
import { api, internal } from "./answer/convex/_generated/api";

test("getPublicStats returns correct static data", async () => {
  const stats = await responseClient.query(api.index.getPublicStats, {});

  expect(stats).toEqual({
    totalUsers: 100,
    version: "1.0.0",
  });
});

test("getPublicStats is accessible to clients", async () => {
  // Should not throw
  await expect(
    responseClient.query(api.index.getPublicStats, {}),
  ).resolves.toBeDefined();
});

test("logClientEvent returns timestamp and is accessible to clients", async () => {
  const now = Date.now();
  const timestamp = await responseClient.mutation(api.index.logClientEvent, {
    eventName: "test_event",
    data: { test: true },
  });

  expect(typeof timestamp).toBe("number");
  expect(timestamp).toBeGreaterThanOrEqual(now);
});

test("logClientEvent handles different data types", async () => {
  const testCases = [
    { eventName: "string_test", data: "test string" },
    { eventName: "number_test", data: 123 },
    { eventName: "boolean_test", data: true },
    { eventName: "object_test", data: { key: "value" } },
    { eventName: "array_test", data: [1, 2, 3] },
    { eventName: "null_test", data: null },
  ];

  for (const testCase of testCases) {
    const timestamp = await responseClient.mutation(
      api.index.logClientEvent,
      testCase,
    );
    expect(typeof timestamp).toBe("number");
  }
});

test("dailyCleanup is not accessible to regular clients", async () => {
  await expect(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    responseClient.action(internal.index.dailyCleanup as any, {}),
  ).rejects.toThrow();
});

test("dailyCleanup is accessible to admin clients", async () => {
  // Should not throw
  await expect(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    responseAdminClient.action(internal.index.dailyCleanup as any, {}),
  ).resolves.toBeNull();
});

test("resetCounter is not accessible to regular clients", async () => {
  await expect(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    responseClient.mutation(internal.index.resetCounter as any, {}),
  ).rejects.toThrow();
});

test("resetCounter is accessible to admin clients", async () => {
  // Should not throw
  await expect(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    responseAdminClient.mutation(internal.index.resetCounter as any, {}),
  ).resolves.toBeNull();
});

test("dailyCleanup and resetCounter log expected messages", async () => {
  const spy = vi.spyOn(console, "log").mockImplementation(() => {});

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await responseAdminClient.action(internal.index.dailyCleanup as any, {});
  const loggedCleanup = spy.mock.calls.some((callArgs) =>
    callArgs.some(
      (arg) => typeof arg === "string" && arg.includes("Running daily cleanup"),
    ),
  );
  expect(loggedCleanup).toBe(true);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await responseAdminClient.mutation(internal.index.resetCounter as any, {});
  const loggedReset = spy.mock.calls.some((callArgs) =>
    callArgs.some(
      (arg) => typeof arg === "string" && arg.includes("Resetting counter"),
    ),
  );
  expect(loggedReset).toBe(true);

  spy.mockRestore();
});

test("function visibility is correctly set", async () => {
  // Public functions should be accessible
  await expect(
    responseClient.query(api.index.getPublicStats, {}),
  ).resolves.toBeDefined();
  await expect(
    responseClient.mutation(api.index.logClientEvent, {
      eventName: "test",
      data: null,
    }),
  ).resolves.toBeDefined();

  // Internal functions should not be accessible to regular clients
  await expect(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    responseClient.action(internal.index.dailyCleanup as any, {}),
  ).rejects.toThrow();
  await expect(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    responseClient.mutation(internal.index.resetCounter as any, {}),
  ).rejects.toThrow();

  // But should be accessible to admin clients
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await expect(
    responseAdminClient.action(internal.index.dailyCleanup as any, {}),
  ).resolves.toBeNull();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await expect(
    responseAdminClient.mutation(internal.index.resetCounter as any, {}),
  ).resolves.toBeNull();
});

test("getPublicStats returns consistent data", async () => {
  const results = await Promise.all([
    responseClient.query(api.index.getPublicStats, {}),
    responseClient.query(api.index.getPublicStats, {}),
    responseClient.query(api.index.getPublicStats, {}),
  ]);

  const [first, ...rest] = results;
  for (const result of rest) {
    expect(result).toEqual(first);
  }
});
