import { afterAll, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { InfrastructureError } from "./convexBackend.js";
import { evaluateVitestReport } from "./scorer.js";

interface FixtureResult {
  kind: "scored" | "error";
  name?: string;
  message?: string;
  scores?: { name: string; score: number }[];
  calls: { method: string; args: unknown[] }[];
}

const complete = { kind: "vitest-end", reason: "passed", unhandledErrors: [] };
const passingReport = {
  numTotalTests: 1,
  numPassedTests: 1,
  numFailedTests: 0,
  success: true,
  testResults: [{ assertionResults: [{ status: "passed" }] }],
};

describe("Vitest result integrity", () => {
  it("does not award credit when a passing assertion report accompanies a failed process", () => {
    expect(() => evaluateVitestReport(passingReport, [complete], 1)).toThrow(
      InfrastructureError,
    );
  });

  it.each([
    ["missing reporter completion", passingReport, []],
    ["duplicate reporter completion", passingReport, [complete, complete]],
    ["malformed event", passingReport, [{ kind: "unknown" }]],
    [
      "interrupted run",
      passingReport,
      [{ ...complete, reason: "interrupted" }],
    ],
    ["missing assertions", { ...passingReport, testResults: [] }, [complete]],
    ["invalid count", { ...passingReport, numPassedTests: 2 }, [complete]],
    ["missing report", null, [complete]],
  ])("rejects %s as unscored", (_label, report, events) => {
    expect(() => evaluateVitestReport(report, events, 0)).toThrow(
      InfrastructureError,
    );
  });
});

// Run the actual scorer and actual Vitest in disposable static evals. A child
// process isolates cwd and reporting mocks from other concurrently running tests.
const repository = resolve(import.meta.dir, "..");
const root = mkdtempSync(join(tmpdir(), "grader-boundary-test-"));
symlinkSync(
  join(repository, "node_modules"),
  join(root, "node_modules"),
  "dir",
);
writeFileSync(join(root, "package.json"), '{"type":"module"}\n');
writeFileSync(
  join(root, "vitest.config.ts"),
  'export default { test: { include: ["evals/**/*.test.ts"], maxWorkers: 1 } };\n',
);
writeFileSync(
  join(root, "score.ts"),
  `
import { mock } from "bun:test";
import { writeFileSync, appendFileSync } from "node:fs";
const calls = [];
mock.module(${JSON.stringify(join(repository, "runner/reporting.ts"))}, () => ({
  recordStep: (...args) => calls.push({ method: "recordStep", args }),
  completeEval: async (...args) => { calls.push({ method: "completeEval", args }); return true; },
  uploadEvalOutput: async (...args) => { calls.push({ method: "uploadEvalOutput", args }); },
}));
const failedReferenceStep = process.env.FAIL_REFERENCE_STEP;
if (failedReferenceStep) {
  // Candidate setup succeeds; the trusted reference setup then fails. No real
  // backend or dependency install is needed to exercise this control flow.
  mock.module(${JSON.stringify(join(repository, "runner/convexBackend.ts"))}, () => ({
    ADMIN_KEY: "unused-test-key",
    InfrastructureError: class InfrastructureError extends Error {
      constructor(message) { super(message); this.name = "InfrastructureError"; }
    },
    withConvexBackend: async (_dir, callback) => callback({ port: 9999, siteProxyPort: 9998 }),
  }));
  mock.module(${JSON.stringify(join(repository, "runner/logging.ts"))}, () => ({
    appendLog: (path, message) => appendFileSync(path, message + "\\n"),
    logInfo: () => {},
    logVitestResults: () => {},
    runCommandStep: async (_path, _handler, step) => {
      calls.push({ method: "commandStep", args: [step] });
      return step === failedReferenceStep
        ? { passed: false, error: "Synthetic reference setup failure" }
        : { passed: true };
    },
  }));
}
const { convexScorer } = await import(${JSON.stringify(join(repository, "runner/scorer.ts"))});
const name = process.argv[2];
let result;
try {
  const scores = await convexScorer(${JSON.stringify(root)}, "", {}, {
    model: "fixture", category: "000-probe", eval_name: name, eval_id: "fixture-eval",
  }, { "package.json": "{}" });
  result = { kind: "scored", scores };
} catch (error) {
  result = { kind: "error", name: error.name, message: error.message };
}
writeFileSync(${JSON.stringify(root)} + "/" + name + ".json", JSON.stringify({ ...result, calls }));
`,
);
afterAll(() => rmSync(root, { recursive: true, force: true }));

const infrastructureImport = `import { failGraderInfrastructure } from ${JSON.stringify(join(repository, "grader/infrastructure.ts"))};`;
const fixtures = [
  {
    name: "pass",
    body: 'test("valid answer", () => expect(1).toBe(1));',
    score: 1,
  },
  {
    name: "assertion-failure",
    body: 'test("passes", () => expect(1).toBe(1)); test("wrong answer", () => expect(1).toBe(2));',
    score: 0.5,
  },
  {
    name: "candidate-error-prefix",
    body: 'test("passes", () => expect(1).toBe(1)); test("candidate exception", () => { throw new Error("GraderInfrastructureError: unsupported runtime"); });',
    score: 0.5,
  },
  {
    name: "trusted-infrastructure",
    body: `${infrastructureImport} test("passes", () => expect(1).toBe(1)); test("probe failed", () => failGraderInfrastructure("Synthetic unsupported syscall", "probe"));`,
  },
  {
    name: "caught-infrastructure",
    body: `${infrastructureImport} test("caught machinery error", () => { try { failGraderInfrastructure("Synthetic caught protocol error", "probe"); } catch {} expect(1).toBe(1); });`,
  },
  {
    name: "unhandled-all-pass",
    body: 'test("passes with machinery rejection", async () => { Promise.reject(new Error("Synthetic unhandled rejection")); await new Promise((resolve) => setImmediate(resolve)); expect(1).toBe(1); });',
  },
  {
    name: "unhandled-and-assertion-failure",
    body: 'test("wrong answer with machinery rejection", async () => { Promise.reject(new Error("Synthetic unhandled rejection")); await new Promise((resolve) => setImmediate(resolve)); expect(1).toBe(2); });',
  },
  { name: "no-tests", body: "export const noAssertions = true;" },
  {
    name: "reference-install-failure",
    body: "",
    failedReferenceStep: "answer-bun",
    expectedMessage: "Reference answer install failed",
  },
  {
    name: "reference-deploy-failure",
    body: "",
    failedReferenceStep: "answer-convex-dev",
    expectedMessage: "Reference answer deploy failed",
  },
] as const;

describe("grader failures through the actual scoring process", () => {
  for (const fixture of fixtures) {
    it(
      fixture.name,
      async () => {
        const evalDir = join(root, "evals", "000-probe", fixture.name);
        mkdirSync(evalDir, { recursive: true });
        writeFileSync(
          join(evalDir, "eval.json"),
          JSON.stringify({
            pipeline: "failedReferenceStep" in fixture ? "backend" : "static",
          }),
        );
        writeFileSync(
          join(evalDir, "grader.test.ts"),
          `import { test, expect } from "vitest";\n${fixture.body}\n`,
        );
        const child = Bun.spawn(["bun", "run", "score.ts", fixture.name], {
          cwd: root,
          env: {
            ...process.env,
            DISABLE_CONVEX_REPORTING: "1",
            ...("failedReferenceStep" in fixture
              ? { FAIL_REFERENCE_STEP: fixture.failedReferenceStep }
              : {}),
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
          readFileSync(join(root, `${fixture.name}.json`), "utf8"),
        ) as FixtureResult;
        const artifactPath = join(
          root,
          "output",
          "fixture",
          "000-probe",
          fixture.name,
          "grader-error.json",
        );
        if ("score" in fixture) {
          expect(result.kind, result.message).toBe("scored");
          expect(
            result.scores?.find((score) => score.name === "Tests pass")?.score,
          ).toBe(fixture.score);
          expect(
            result.calls.filter(
              (call: { method: string }) => call.method === "completeEval",
            ),
          ).toHaveLength(1);
          expect(existsSync(artifactPath)).toBe(false);
        } else {
          expect(result.kind).toBe("error");
          expect(result.name).toBe("InfrastructureError");
          if ("expectedMessage" in fixture)
            expect(result.message).toContain(fixture.expectedMessage);
          expect(result.scores).toBeUndefined();
          expect(
            result.calls.filter(
              (call: { method: string }) => call.method === "completeEval",
            ),
          ).toHaveLength(0);
          expect(
            result.calls.filter(
              (call: { method: string; args: unknown[] }) =>
                call.method === "recordStep" && call.args[1] === "tests",
            ),
          ).toHaveLength(0);
          expect(
            (
              JSON.parse(readFileSync(artifactPath, "utf8")) as {
                score: unknown;
              }
            ).score,
          ).toBeNull();
          expect(
            readFileSync(
              join(
                root,
                "output",
                "fixture",
                "000-probe",
                fixture.name,
                "run.log",
              ),
              "utf8",
            ),
          ).toContain("[infrastructure]");
        }
      },
      30_000,
    );
  }
});
