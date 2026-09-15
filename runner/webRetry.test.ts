import { describe, expect, it } from "bun:test";
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

type FixtureUsage = {
  totalTokens?: number;
  raw: {
    providerAttempts: unknown[];
    openRouterGenerationIds: string[];
    providerUsageExcludesFailedAttempts: boolean;
    providerUsageScope: string;
    cost?: number;
  };
};
type FixtureEvent =
  | { kind: "scored"; usage: FixtureUsage; output: Record<string, string> }
  | {
      kind: "eval";
      status: { kind: string; failureReason?: string; usage: FixtureUsage };
    }
  | {
      kind: "run";
      status: { kind: string; failureReason?: string; usage: FixtureUsage };
    };

// Run in a child so module mocks cannot leak into other runner tests. Only the
// HTTP transport, scoring and reporting are replaced; the SDK and retry loop run.
describe("web retries through the runner", () => {
  it.each(["recover", "exhaust", "permanent"])(
    "records and reports %s",
    async (scenario) => {
      const repository = resolve(import.meta.dir, "..");
      const root = mkdtempSync(join(tmpdir(), "web-retry-runner-"));
      try {
        symlinkSync(
          join(repository, "node_modules"),
          join(root, "node_modules"),
          "dir",
        );
        const fixture = join(root, "evals", "000-probe", "000-retry");
        mkdirSync(join(fixture, "answer"), { recursive: true });
        writeFileSync(join(fixture, "TASK.txt"), "Build a backend.");
        writeFileSync(join(fixture, "answer", "package.json"), "{}");
        const modulePath = (path: string): string =>
          JSON.stringify(join(repository, path));
        writeFileSync(
          join(root, "run.ts"),
          `
import { mock } from "bun:test";
import { writeFileSync } from "node:fs";
const events = [];
let requests = 0;
globalThis.fetch = async (url) => {
  if (url !== "https://openrouter.ai/api/v1/chat/completions") throw new Error("Unexpected network access: " + url);
  requests++;
  const id = "gen-" + requests;
  const success = ${JSON.stringify(scenario)} === "recover" && requests === 2;
  const chunks = ${JSON.stringify(scenario)} === "permanent"
    ? [{ id, error: { code: 402, message: "No credit" } }]
    : [{ id, choices: [{ index: 0, delta: { content: success ? "# Files\\n\\n## package.json\\n\\n~~~json\\n{}\\n~~~" : "partial output" } }] },
       ...(success ? [{ id, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20, cost: 0.25 } }] : [])];
  return new Response(chunks.map((chunk) => "data: " + JSON.stringify(chunk) + "\\n\\n").join("") + "data: [DONE]\\n\\n", { headers: { "content-type": "text/event-stream" } });
};
mock.module(${modulePath("runner/models/openRouterDiscovery.ts")}, () => ({
  resolveModel: () => { throw new Error("Unexpected discovery"); },
  preflightOpenRouterEndpoint: async () => {},
}));
mock.module(${modulePath("runner/benchmark.ts")}, () => ({ computeBenchmarkDefinition: () => ({ version: "fixture", evalCount: 1 }) }));
mock.module(${modulePath("runner/scorer.ts")}, () => ({
  getEvalPipeline: () => "static",
  walkAnswer: function* (dir) { yield dir + "/package.json"; },
  convexScorer: async (_temp, _task, _expected, metadata, output) => {
    events.push({ kind: "scored", usage: metadata.usage, output });
    return [{ name: "Tests pass", score: 1 }];
  },
}));
mock.module(${modulePath("runner/reporting.ts")}, () => ({
  ensureModelFromSlug: async () => "model",
  startRun: async () => "run",
  startEval: async () => "eval",
  getOrUploadEvalSource: async () => ({}),
  completeEval: async (_id, status) => events.push({ kind: "eval", status }),
  completeRun: async (_id, status) => events.push({ kind: "run", status }),
  printEvalSummary: () => {}, closeClient: async () => {},
}));
const { resolveModelDefaults } = await import(${modulePath("runner/models/index.ts")});
const { runEvalsForModel } = await import(${modulePath("runner/index.ts")});
let error;
try {
  await runEvalsForModel({
    model: resolveModelDefaults("test/model"),
    experiment: "no_guidelines_with_web", tempdir: ${JSON.stringify(root)},
    convexEvalUrl: "mock-only", convexAuthToken: "mock-only",
  });
} catch (e) { error = String(e); }
writeFileSync("result.json", JSON.stringify({ requests, events, error }));
`,
        );
        const child = Bun.spawn(["bun", "run.ts"], {
          cwd: root,
          env: {
            ...process.env,
            OPENROUTER_API_KEY: "fixture-only",
            DISABLE_CONVEX_REPORTING: "1",
          },
          stdout: "pipe",
          stderr: "pipe",
        });
        const [exit, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        expect(exit, stdout + stderr).toBe(0);
        const result = JSON.parse(
          readFileSync(join(root, "result.json"), "utf8"),
        ) as { requests: number; events: FixtureEvent[]; error?: string };
        const attempts =
          scenario === "recover" ? 2 : scenario === "exhaust" ? 3 : 1;
        expect(result.requests, stdout + stderr).toBe(attempts);
        expect(stdout).toContain(
          `Provider attempt ${scenario === "recover" ? 1 : attempts}:`,
        );
        const run = result.events.find((event) => event.kind === "run");
        const scored = result.events.find((event) => event.kind === "scored");
        const failed = result.events.find((event) => event.kind === "eval");
        const usage =
          scenario === "recover" ? scored!.usage : failed!.status.usage;
        expect(usage.raw.providerAttempts).toHaveLength(attempts);
        expect(usage.raw.openRouterGenerationIds).toEqual(
          Array.from({ length: attempts }, (_, i) => `gen-${i + 1}`),
        );
        expect(usage.raw.providerUsageExcludesFailedAttempts).toBe(true);
        if (scenario === "recover") {
          expect(result.error).toBeUndefined();
          expect(scored!.output).toEqual({ "package.json": "{}" });
          expect(run!.status.kind).toBe("completed");
          expect(usage.raw.cost).toBe(0.25);
          expect(usage.raw.providerUsageScope).toBe("successful_attempt_only");
        } else {
          expect(result.error).toContain("OpenRouter web response failed");
          expect(scored).toBeUndefined();
          expect(run!.status.kind).toBe("failed");
          expect(failed!.status.failureReason).toContain("[infrastructure]");
          expect(usage.totalTokens).toBeUndefined();
          expect(usage.raw.cost).toBeUndefined();
          expect(usage.raw.providerUsageScope).toBe("unavailable");
        }
        for (let i = 1; i <= attempts; i++) {
          const trace: unknown = JSON.parse(
            readFileSync(
              join(
                root,
                "research",
                "test/model",
                "000-probe",
                "000-retry",
                `attempt-${i}.json`,
              ),
              "utf8",
            ),
          );
          expect((trace as { status: string }).status).toBe(
            scenario === "recover" && i === 2 ? "completed" : "failed",
          );
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    20_000,
  );
});
