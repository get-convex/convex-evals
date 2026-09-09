import { describe, expect, it } from "bun:test";
import { rejects } from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runEvalQueue } from "./index.js";

describe("eval queue", () => {
  it("runs each item once without exceeding concurrency", async () => {
    let active = 0;
    let peak = 0;
    const completed: number[] = [];
    await runEvalQueue([0, 1, 2, 3, 4], 2, async (item) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => setImmediate(resolve));
      completed.push(item);
      active--;
    });
    expect(peak).toBe(2);
    expect(completed.sort()).toEqual([0, 1, 2, 3, 4]);
  });

  it("rejects invalid concurrency without starting work", async () => {
    let started = false;
    await rejects(
      runEvalQueue([1], 0, async () => {
        started = true;
      }),
      /positive integer/,
    );
    expect(started).toBe(false);
  });

  it.each([false, true])(
    "drains an active run before restoring environment (late worker failure: %s)",
    async (lateFailure) => {
      const repository = resolve(import.meta.dir, "..");
      const root = mkdtempSync(join(tmpdir(), "eval-run-drain-"));
      try {
        symlinkSync(
          join(repository, "node_modules"),
          join(root, "node_modules"),
          "dir",
        );
        for (const name of ["000-first", "001-active", "002-never-started"]) {
          const dir = join(root, "evals", "000-probe", name);
          mkdirSync(join(dir, "answer"), { recursive: true });
          writeFileSync(join(dir, "TASK.txt"), "Queue lifecycle fixture");
          writeFileSync(join(dir, "answer", "package.json"), "{}");
        }
        writeFileSync(
          join(root, "run.ts"),
          `
import { mock } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { InfrastructureError } from ${JSON.stringify(join(repository, "runner/convexBackend.ts"))};
const events = [];
const unhandled = [];
process.on("unhandledRejection", (error) => unhandled.push(String(error)));
const snapshot = () => ({ experiment: process.env.EVALS_EXPERIMENT, guidelines: process.env.CUSTOM_GUIDELINES_PATH });
let releaseFirst, releaseActive, activeStarted;
const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
const activeGate = new Promise((resolve) => { releaseActive = resolve; });
const startedGate = new Promise((resolve) => { activeStarted = resolve; });
const firstError = new InfrastructureError("first trusted grader failure");
mock.module(${JSON.stringify(join(repository, "runner/scorer.ts"))}, () => ({
  getEvalPipeline: () => "static",
  walkAnswer: function* (dir) { yield join(dir, "package.json"); },
  convexScorer: async (_tempdir, _input, _expected, metadata) => {
    events.push({ kind: "start", name: metadata.eval_name, ...snapshot() });
    if (metadata.eval_name === "000-first") { await firstGate; throw firstError; }
    if (metadata.eval_name === "001-active") {
      activeStarted();
      await activeGate;
      events.push({ kind: "active-report", ...snapshot() });
      if (${lateFailure}) throw new Error("late worker failure");
    }
    return [{ name: "Tests pass", score: 1 }];
  },
}));
mock.module(${JSON.stringify(join(repository, "runner/benchmark.ts"))}, () => ({
  computeBenchmarkDefinition: () => ({ version: "fixture-version", evalCount: 3 }),
}));
mock.module(${JSON.stringify(join(repository, "runner/reporting.ts"))}, () => ({
  ensureModelFromSlug: async () => "fixture-model",
  startRun: async () => "fixture-run",
  startEval: async (_run, _path, _category, name) => "fixture-" + name,
  getOrUploadEvalSource: async () => ({ taskContent: null, storageId: null }),
  completeRun: async (_runId, status) => { events.push({ kind: "complete-run", status, ...snapshot() }); return true; },
  completeEval: async () => { events.push({ kind: "unexpected-complete-eval" }); return true; },
  printEvalSummary: () => events.push({ kind: "unexpected-summary" }),
  closeClient: async () => {},
}));
const { runEvalsForModel } = await import(${JSON.stringify(join(repository, "runner/index.ts"))});
process.env.EVALS_EXPERIMENT = "before-run";
process.env.CUSTOM_GUIDELINES_PATH = "/before-run";
let settled = false;
let caught;
const run = runEvalsForModel({
  model: { name: "fixture", formattedName: "Fixture", apiKind: "chat" },
  executionMode: "answer", experiment: "no_guidelines", customGuidelinesPath: "/during-run",
  convexEvalUrl: "fixture-only", convexAuthToken: "fixture-only", tempdir: ${JSON.stringify(root)},
}).then(() => { settled = true; }, (error) => { settled = true; caught = error; });
await startedGate;
releaseFirst();
await new Promise((resolve) => setImmediate(resolve));
events.push({ kind: "checkpoint", settled, ...snapshot() });
releaseActive();
await run;
await new Promise((resolve) => setImmediate(resolve));
events.push({ kind: "restored", ...snapshot() });
writeFileSync(${JSON.stringify(join(root, "result.json"))}, JSON.stringify({ events, unhandled, sameError: caught === firstError }));
`,
        );
        const child = Bun.spawn(["bun", "run", "run.ts"], {
          cwd: root,
          env: {
            ...process.env,
            OPENROUTER_CONCURRENCY: "2",
            DISABLE_CONVEX_REPORTING: "1",
          },
          stdout: "pipe",
          stderr: "pipe",
        });
        const [exitCode, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        expect(exitCode, stdout + stderr).toBe(0);
        const result = JSON.parse(
          readFileSync(join(root, "result.json"), "utf8"),
        ) as {
          events: {
            kind: string;
            name?: string;
            settled?: boolean;
            experiment?: string;
            guidelines?: string;
            status?: { kind: string };
          }[];
          unhandled: string[];
          sameError: boolean;
        };
        expect(result.sameError).toBe(true);
        expect(result.unhandled).toEqual([]);
        expect(
          result.events
            .filter((event) => event.kind === "start")
            .map((event) => event.name),
        ).toEqual(["000-first", "001-active"]);
        expect(
          result.events.find((event) => event.kind === "checkpoint"),
        ).toMatchObject({
          settled: false,
          experiment: "no_guidelines",
          guidelines: "/during-run",
        });
        expect(
          result.events.find((event) => event.kind === "active-report"),
        ).toMatchObject({
          experiment: "no_guidelines",
          guidelines: "/during-run",
        });
        expect(
          result.events.find((event) => event.kind === "complete-run"),
        ).toMatchObject({
          status: { kind: "failed" },
          experiment: "no_guidelines",
          guidelines: "/during-run",
        });
        expect(
          result.events.findIndex((event) => event.kind === "active-report"),
        ).toBeLessThan(
          result.events.findIndex((event) => event.kind === "complete-run"),
        );
        expect(result.events.at(-1)).toMatchObject({
          kind: "restored",
          experiment: "before-run",
          guidelines: "/before-run",
        });
        expect(
          result.events.some((event) => event.kind.startsWith("unexpected")),
        ).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    15_000,
  );
});
