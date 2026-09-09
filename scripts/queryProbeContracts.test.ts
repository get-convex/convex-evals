import { afterAll, expect } from "bun:test";
import { rejects } from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { GraderInfrastructureError } from "../grader/infrastructure";
import { inspectQuery } from "../grader/querySandbox";
import { nativeProbeTest } from "./lib/nativeProbeTest";

const test = nativeProbeTest();
const project = mkdtempSync(join(tmpdir(), "missing-query-module-"));
mkdirSync(join(project, "convex"));
writeFileSync(join(project, "convex/unrelated.ts"), "export const value = 1;");
symlinkSync(resolve("node_modules"), join(project, "node_modules"), "junction");
afterAll(() => rmSync(project, { recursive: true, force: true }));

for (const [evalPath, input] of [
  ["002-queries/022-unbounded_query_no_collect", "workspace"],
  ["002-queries/024-time_window_argument", { timeArgName: "now", now: 1 }],
  ["005-idioms/006-typed_env", { env: {} }],
  ["005-idioms/008-nested_transaction_limits", { job: {} }],
  ["005-idioms/009-platform_env_urls", { env: {} }],
] as const) {
  test(`${evalPath}: a missing required module is a candidate failure`, async () => {
    await rejects(
      inspectQuery(
        project,
        pathToFileURL(resolve("evals", evalPath, "inspect.mjs")),
        input,
      ),
      (error) => {
        expect(error).toBeInstanceOf(Error);
        expect(error).not.toBeInstanceOf(GraderInfrastructureError);
        if (!(error instanceof Error)) return false;
        expect(error.message).toContain("Missing required module");
        return true;
      },
    );
  });
}
