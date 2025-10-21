import { expect, test } from "vitest";
import { responseAdminClient, addDocuments } from "../../../grader";

test("configurations accepts valid literal and union values", async () => {
  await expect(
    addDocuments(responseAdminClient, "configurations", [
      {
        environment: "production",
        logLevel: "info",
        priority: 2,
        enabled: 1,
        status: "active",
        feature: { type: "basic", allowed: true },
      },
      {
        environment: "production",
        logLevel: "warn",
        priority: 3,
        enabled: 0,
        status: null,
        feature: { type: "advanced", allowed: false },
      },
    ]),
  ).resolves.toBeUndefined();
});

test("configurations rejects invalid literal and union values", async () => {
  // Invalid environment literal
  await expect(
    addDocuments(responseAdminClient, "configurations", [
      {
        environment: "staging",
        logLevel: "info",
        priority: 1,
        enabled: 0,
        status: "inactive",
        feature: { type: "basic", allowed: true },
      },
    ]),
  ).rejects.toThrow();

  // Invalid logLevel
  await expect(
    addDocuments(responseAdminClient, "configurations", [
      {
        environment: "production",
        logLevel: "verbose",
        priority: 1,
        enabled: 0,
        status: 1,
        feature: { type: "basic", allowed: true },
      },
    ]),
  ).rejects.toThrow();

  // Invalid priority and enabled
  await expect(
    addDocuments(responseAdminClient, "configurations", [
      {
        environment: "production",
        logLevel: "debug",
        priority: 4,
        enabled: true,
        status: 0,
        feature: { type: "basic", allowed: true },
      },
    ]),
  ).rejects.toThrow();

  // Invalid feature type
  await expect(
    addDocuments(responseAdminClient, "configurations", [
      {
        environment: "production",
        logLevel: "error",
        priority: 1,
        enabled: 0,
        status: "inactive",
        feature: { type: "pro", allowed: true },
      },
    ]),
  ).rejects.toThrow();
});
