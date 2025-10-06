import { expect, test } from "vitest";
import { responseAdminClient } from "../../../grader";
import { anyApi } from "convex/server";

test("internal emptyAction callable with and without scheduleDescription", async () => {
  const resultNoArg: unknown = await responseAdminClient.action(
    anyApi.crons.emptyAction,
    {},
  );
  expect(resultNoArg).toBe(null);

  const resultWithArg: unknown = await responseAdminClient.action(
    anyApi.crons.emptyAction,
    { scheduleDescription: "run every minute" },
  );
  expect(resultWithArg).toBe(null);
});

test("defines four cron schedules with expected labels and timing", async () => {
  type AdminQuery = {
    query: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  };
  const adminClient = responseAdminClient as unknown as AdminQuery;
  const spec: unknown = await adminClient.query(
    "_system/cli/modules:apiSpec",
    {},
  );
  const specText = JSON.stringify(spec);
  expect(specText).toContain("run every second");
  expect(specText).toContain("run every minute");
  expect(specText).toContain("run every hour");
  expect(specText).toContain("run every month on the 11th day at 1pm UTC");
  expect(specText).toContain("0 13 11 * *");
});
