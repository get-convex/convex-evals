import { afterAll, expect, test } from "vitest";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { randomUUID } from "node:crypto";
import { inspect } from "node:util";
import {
  adminKey,
  cloudUrl,
  compareFunctionSpec,
  getLatestOutputProjectDir,
  pollUntil,
  siteUrl,
} from "../../../grader";
import {
  type DeploymentInfo,
  deploymentInfoMatches,
  expectedDeploymentInfo,
  generatedEnvMembers,
  inspectPlatformEnv,
  platformEnvCases,
} from "./checks";

const projectDir = (): string =>
  getLatestOutputProjectDir("005-idioms", "009-platform_env_urls");
const getDeploymentInfo = makeFunctionReference<
  "query",
  Record<string, never>,
  DeploymentInfo
>("deployment:getDeploymentInfo");

async function setAppName(value: string | null): Promise<void> {
  const response = await fetch(`${cloudUrl}/api/update_environment_variables`, {
    method: "POST",
    headers: {
      Authorization: `Convex ${adminKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ changes: [{ name: "PUBLIC_APP_NAME", value }] }),
  });
  if (!response.ok)
    throw new Error(
      `Environment update failed: ${response.status} ${await response.text()}`,
    );
}

async function expectDeploymentInfo(appName: string | null): Promise<void> {
  const expected = { siteUrl, cloudUrl, appName };
  let latest: DeploymentInfo | undefined;
  // Fresh HTTP requests avoid subscription caches after configuration updates.
  await pollUntil(
    async () => {
      latest = await new ConvexHttpClient(cloudUrl).query(
        getDeploymentInfo,
        {},
      );
      return deploymentInfoMatches(latest, expected);
    },
    { timeoutMs: 5_000, intervalMs: 100 },
  ).catch((error) => {
    expect(
      latest,
      `Deployment info after env update (${String(error)})`,
    ).toEqual(expected);
  });
}

afterAll(async () => {
  await setAppName(null);
});

test("compare function spec", async ({ skip }) => {
  await compareFunctionSpec(skip, {
    ignoreReturns: true,
    publicOnly: true,
    allowAdditionalFunctions: true,
  });
});

test(
  "returns this deployment's URLs and null when the app name is unset",
  { timeout: 10_000 },
  async () => {
    await setAppName(null);
    await expectDeploymentInfo(null);
  },
);

test(
  "follows app name configuration changes while preserving both platform URLs",
  { timeout: 35_000 },
  async () => {
    try {
      for (const value of [
        `App ${randomUUID()}`,
        `Changed ${randomUUID()}`,
        "",
        null,
      ]) {
        await setAppName(value);
        await expectDeploymentInfo(value);
      }
    } finally {
      await setAppName(null);
    }
  },
);

test("generated types contain the two platform URLs and only the optional app declaration", () => {
  expect(generatedEnvMembers(projectDir())).toEqual([
    { name: "CONVEX_CLOUD_URL", types: ["string"] },
    { name: "CONVEX_SITE_URL", types: ["string"] },
    { name: "PUBLIC_APP_NAME", types: ["string", "undefined"] },
  ]);
});

test(
  "executed query reads the generated env values without raw environment reads",
  { timeout: 30_000 },
  async () => {
    const reads = new Set<string>();
    // Fresh sandboxes permit module-level destructuring. Backend updates above
    // independently verify configuration freshness.
    for (const env of platformEnvCases(randomUUID())) {
      const inspected = await inspectPlatformEnv(projectDir(), env);
      expect(
        deploymentInfoMatches(inspected.result, expectedDeploymentInfo(env)),
        inspect(inspected.result),
      ).toBe(true);
      inspected.reads.forEach((key) => reads.add(key));
    }
    expect([...reads].sort()).toEqual([
      "CONVEX_CLOUD_URL",
      "CONVEX_SITE_URL",
      "PUBLIC_APP_NAME",
    ]);
  },
);
