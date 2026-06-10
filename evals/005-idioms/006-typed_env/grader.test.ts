import { expect, test } from "vitest";
import { responseClient, readOutputFile } from "../../../grader";
import { makeFunctionReference } from "convex/server";

const getSupportConfig = makeFunctionReference<
  "query",
  Record<string, never>,
  {
    supportEmail: string | null;
    deploymentStage: "dev" | "preview" | "prod";
    isConfigured: boolean;
  }
>("config:getSupportConfig");

test("returns defaults when optional env vars are absent", async () => {
  const result = await responseClient.query(getSupportConfig, {});

  expect(result).toEqual({
    supportEmail: null,
    deploymentStage: "dev",
    isConfigured: false,
  });
});

test("declares typed env vars in convex.config.ts", () => {
  const source = readOutputFile(
    "005-idioms",
    "006-typed_env",
    "convex/convex.config.ts",
  );

  expect(source).toContain("defineApp");
  expect(source).toContain("SUPPORT_EMAIL");
  expect(source).toContain("DEPLOYMENT_STAGE");
  expect(source).toContain("v.optional(v.string())");
  expect(source).toContain('v.literal("dev")');
  expect(source).toContain('v.literal("preview")');
  expect(source).toContain('v.literal("prod")');
});

test("uses generated env object instead of process.env for app vars", () => {
  const source = readOutputFile(
    "005-idioms",
    "006-typed_env",
    "convex/config.ts",
  );

  expect(source).toContain("env");
  expect(source).toContain("SUPPORT_EMAIL");
  expect(source).toContain("DEPLOYMENT_STAGE");
  expect(source).not.toContain("process.env.SUPPORT_EMAIL");
  expect(source).not.toContain("process.env.DEPLOYMENT_STAGE");
});
