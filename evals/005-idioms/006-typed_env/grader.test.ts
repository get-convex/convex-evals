import { afterAll, expect, test } from "vitest";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { randomUUID } from "node:crypto";
import {
  adminKey,
  cloudUrl,
  compareFunctionSpec,
  getLatestOutputProjectDir,
  pollUntil,
} from "../../../grader";
import {
  type AppEnv,
  declaredAppEnvTypes,
  expectedSupportConfig,
  inspectTypedAppEnv,
  supportConfigCases,
} from "./checks";

const projectDir = (): string =>
  getLatestOutputProjectDir("005-idioms", "006-typed_env");
const getSupportConfig = makeFunctionReference<
  "query",
  Record<string, never>,
  ReturnType<typeof expectedSupportConfig>
>("config:getSupportConfig");

async function setAppEnv(env: AppEnv): Promise<void> {
  const response = await fetch(`${cloudUrl}/api/update_environment_variables`, {
    method: "POST",
    headers: {
      Authorization: `Convex ${adminKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      changes: [
        { name: "SUPPORT_EMAIL", value: env.SUPPORT_EMAIL ?? null },
        { name: "DEPLOYMENT_STAGE", value: env.DEPLOYMENT_STAGE ?? null },
      ],
    }),
  });
  if (!response.ok)
    throw new Error(
      `Environment update failed: ${response.status} ${await response.text()}`,
    );
}

async function expectConfig(env: AppEnv): Promise<void> {
  const expected = expectedSupportConfig(env);
  let latest: unknown;
  // A fresh HTTP query avoids client-side subscription caching after updates.
  await pollUntil(
    async () => {
      const actual = await new ConvexHttpClient(cloudUrl).query(
        getSupportConfig,
        {},
      );
      latest = actual;
      return (
        actual?.supportEmail === expected.supportEmail &&
        actual?.deploymentStage === expected.deploymentStage &&
        actual?.isConfigured === expected.isConfigured
      );
    },
    { timeoutMs: 5_000, intervalMs: 100 },
  ).catch((error) => {
    expect(latest, `Config after env update (${String(error)})`).toMatchObject(
      expected,
    );
  });
}

afterAll(async () => {
  await setAppEnv({});
});

test(
  "public query returns defaults when optional env vars are absent",
  { timeout: 10_000 },
  async ({ skip }) => {
    await compareFunctionSpec(skip, {
      ignoreReturns: true,
      publicOnly: true,
      allowAdditionalFunctions: true,
    });
    await setAppEnv({});
    await expectConfig({});
  },
);

test("declares the optional string and exact stage union through typed env", () => {
  const types = declaredAppEnvTypes(projectDir());
  expect(types.SUPPORT_EMAIL).toEqual(["string", "undefined"]);
  expect(types.DEPLOYMENT_STAGE).toEqual([
    "literal:dev",
    "literal:preview",
    "literal:prod",
    "undefined",
  ]);
});

test(
  "query follows configured values when app env vars are set, changed, and removed",
  { timeout: 50_000 },
  async () => {
    try {
      for (const env of supportConfigCases(randomUUID())) {
        await setAppEnv(env);
        await expectConfig(env);
      }
    } finally {
      await setAppEnv({});
    }
  },
);

test(
  "configured values come from generated env without raw app-variable reads",
  { timeout: 30_000 },
  async () => {
    const reads = new Set<string>();
    // Each sandbox starts afresh: module-level destructuring is a valid pattern.
    // Real deployment updates above independently check freshness on the backend.
    for (const env of supportConfigCases(randomUUID())) {
      const inspected = await inspectTypedAppEnv(projectDir(), env);
      expect(inspected.result).toMatchObject(expectedSupportConfig(env));
      inspected.reads.forEach((key) => reads.add(key));
    }
    expect([...reads].sort()).toEqual(["DEPLOYMENT_STAGE", "SUPPORT_EMAIL"]);
  },
);
