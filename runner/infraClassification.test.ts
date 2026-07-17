import { describe, expect, test } from "vitest";
import { isInfrastructureStepFailure } from "./scorer";

describe("isInfrastructureStepFailure", () => {
  test("model failures in evals with rate_limit in their path are not infrastructure", () => {
    const tscError =
      "Failed to typecheck code:\n" +
      "/tmp/convex-evals-1/output/m/007-components/001-transactional_rate_limit/convex/index.ts(23,7): " +
      "error TS2353: 'rate' does not exist in type '{ config: RateLimitConfig }'.";
    expect(isInfrastructureStepFailure("tsc", tscError)).toBe(false);
    expect(isInfrastructureStepFailure("deploy", tscError)).toBe(false);
    expect(isInfrastructureStepFailure("install", tscError)).toBe(false);
  });

  test("provider throttling still classifies as infrastructure", () => {
    expect(
      isInfrastructureStepFailure("install", "npm error status code 429"),
    ).toBe(true);
    expect(
      isInfrastructureStepFailure("tsc", "request failed: too many requests"),
    ).toBe(true);
    expect(isInfrastructureStepFailure("deploy", "connect ECONNREFUSED")).toBe(
      true,
    );
  });
});

import { mkdtempSync, writeFileSync as wf, readFileSync as rf } from "node:fs";
import { tmpdir } from "node:os";
import { join as pjoin } from "node:path";
import { normalizeModelTsconfigResolution } from "./scorer";

describe("normalizeModelTsconfigResolution", () => {
  test("rewrites legacy node resolution to Bundler and commonjs to ESNext", () => {
    const dir = mkdtempSync(pjoin(tmpdir(), "tsconfig-norm-"));
    wf(
      pjoin(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { module: "commonjs", moduleResolution: "node" },
      }),
    );
    const changes = normalizeModelTsconfigResolution(dir);
    expect(changes).toHaveLength(2);
    const parsed = JSON.parse(rf(pjoin(dir, "tsconfig.json"), "utf-8")) as {
      compilerOptions: { moduleResolution: string; module: string };
    };
    expect(parsed.compilerOptions.moduleResolution).toBe("Bundler");
    expect(parsed.compilerOptions.module).toBe("ESNext");
  });

  test("normalizes configs that omit resolution fields entirely", () => {
    const dir = mkdtempSync(pjoin(tmpdir(), "tsconfig-norm-"));
    wf(
      pjoin(dir, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { strict: true } }),
    );
    const changes = normalizeModelTsconfigResolution(dir);
    expect(changes).toHaveLength(2);
    const parsed = JSON.parse(rf(pjoin(dir, "tsconfig.json"), "utf-8")) as {
      compilerOptions: { moduleResolution: string; module: string };
    };
    expect(parsed.compilerOptions.moduleResolution).toBe("Bundler");
    expect(parsed.compilerOptions.module).toBe("ESNext");
  });

  test("normalizes tsconfigs with no compilerOptions at all", () => {
    const dir = mkdtempSync(pjoin(tmpdir(), "tsconfig-norm-"));
    wf(pjoin(dir, "tsconfig.json"), JSON.stringify({}));
    expect(normalizeModelTsconfigResolution(dir)).toHaveLength(2);
    const parsed = JSON.parse(rf(pjoin(dir, "tsconfig.json"), "utf-8")) as {
      compilerOptions: { moduleResolution: string; module: string };
    };
    expect(parsed.compilerOptions.moduleResolution).toBe("Bundler");
  });

  test("leaves modern configs untouched", () => {
    const dir = mkdtempSync(pjoin(tmpdir(), "tsconfig-norm-"));
    wf(
      pjoin(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { module: "ESNext", moduleResolution: "Bundler" },
      }),
    );
    expect(normalizeModelTsconfigResolution(dir)).toHaveLength(0);
  });

  test("appends dom to an explicit lib that omits it", () => {
    const dir = mkdtempSync(pjoin(tmpdir(), "tsconfig-norm-"));
    wf(
      pjoin(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          module: "ESNext",
          moduleResolution: "Bundler",
          lib: ["ES2021"],
        },
      }),
    );
    const changes = normalizeModelTsconfigResolution(dir);
    expect(changes).toHaveLength(1);
    const parsed = JSON.parse(rf(pjoin(dir, "tsconfig.json"), "utf-8")) as {
      compilerOptions: { lib: string[] };
    };
    expect(parsed.compilerOptions.lib).toEqual(["ES2021", "dom"]);
  });

  test("leaves lib untouched when dom is present or lib is absent", () => {
    const dir = mkdtempSync(pjoin(tmpdir(), "tsconfig-norm-"));
    wf(
      pjoin(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          module: "ESNext",
          moduleResolution: "Bundler",
          lib: ["ES2021", "DOM"],
        },
      }),
    );
    expect(normalizeModelTsconfigResolution(dir)).toHaveLength(0);
    wf(
      pjoin(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { module: "ESNext", moduleResolution: "Bundler" },
      }),
    );
    expect(normalizeModelTsconfigResolution(dir)).toHaveLength(0);
  });
});
