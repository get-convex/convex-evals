import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { runDecisions, type DecisionRunOptions } from "./run.js";
import {
  createDecisionReporter,
  compactDecisionJournalRow,
  decisionReportingTarget,
  DECISION_DEVELOPMENT_URL,
  DECISION_PRODUCTION_URL,
  encodeDecisionRunEvidence,
  type DecisionTransport,
} from "./reporting.js";
import {
  assertSafeSourcePath,
  createDecisionSourceSnapshot,
  recomputeSnapshotBenchmark,
} from "./source.js";
import { presentQuestion } from "./questions.js";
import { buildProviderRequest } from "./providers.js";
import { canonicalJson } from "../../evalScores/convex/decisionIdentity.js";
import {
  MAX_DECISION_RUN_EVIDENCE_COMPRESSED_BYTES,
  MAX_DECISION_RUN_EVIDENCE_DECOMPRESSED_BYTES,
} from "../../evalScores/convex/decisionConfig.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
function uploadedText(bytes: string | Uint8Array): string {
  if (typeof bytes === "string") return bytes;
  return bytes[0] === 0x1f && bytes[1] === 0x8b
    ? gunzipSync(bytes).toString("utf8")
    : Buffer.from(bytes).toString("utf8");
}
function uploadedJson(bytes: string | Uint8Array): Record<string, unknown> {
  return JSON.parse(uploadedText(bytes)) as Record<string, unknown>;
}
const commit = "1".repeat(40);
const environment = {
  CONVEX_EVAL_URL: DECISION_PRODUCTION_URL,
  CONVEX_AUTH_TOKEN: "test-token",
  GITHUB_ACTIONS: "true",
  GITHUB_REF: "refs/heads/main",
  GITHUB_REPOSITORY: "get-convex/convex-evals",
  GITHUB_SHA: commit,
  GITHUB_RUN_ID: "123",
  GITHUB_RUN_ATTEMPT: "1",
  GITHUB_WORKFLOW_REF:
    "get-convex/convex-evals/.github/workflows/decision_evals.yml@refs/heads/main",
};
const temporary: string[] = [];
async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error("Expected a rejected promise");
}
afterEach(() =>
  temporary
    .splice(0)
    .forEach((path) => rmSync(path, { force: true, recursive: true })),
);

describe("decision reporting boundary", () => {
  it("allows the main workflow and explicit dev, rejects local/branch/unknown targets", () => {
    expect(decisionReportingTarget(environment, commit)?.metadata.scope).toBe(
      "github-actions",
    );
    expect(
      decisionReportingTarget(
        { ...environment, CONVEX_EVAL_URL: `${DECISION_PRODUCTION_URL}/` },
        commit,
      )?.url,
    ).toBe(DECISION_PRODUCTION_URL);
    expect(
      decisionReportingTarget({ DISABLE_CONVEX_REPORTING: "1" }, commit),
    ).toBeNull();
    for (const changes of [
      { GITHUB_ACTIONS: "false" },
      { GITHUB_REF: "refs/heads/feature" },
      { GITHUB_REPOSITORY: "someone/fork" },
      { GITHUB_SHA: "2".repeat(40) },
      { GITHUB_WORKFLOW_REF: "other-workflow" },
      { CONVEX_EVAL_URL: "https://unknown.convex.cloud" },
      { CONVEX_EVAL_URL: `${DECISION_PRODUCTION_URL}/?secret=no` },
    ])
      expect(() =>
        decisionReportingTarget({ ...environment, ...changes }, commit),
      ).toThrow();
    expect(() =>
      decisionReportingTarget(environment, commit, "development"),
    ).toThrow();
    expect(
      decisionReportingTarget(
        { CONVEX_EVAL_URL: DECISION_DEVELOPMENT_URL, CONVEX_AUTH_TOKEN: "dev" },
        commit,
        "development",
      )?.origin.kind,
    ).toBe("development");
  });
});

function fixture(): DecisionRunOptions {
  const output = mkdtempSync(join(tmpdir(), "decision-report-test-"));
  temporary.push(output);
  const envFile = join(output, "provider.env");
  writeFileSync(envFile, "OPENROUTER_API_KEY=fake-provider-key\n");
  return {
    projectRoot: root,
    outputRoot: output,
    envFile,
    config: {
      provider: "openrouter",
      model: "fixture-model",
      reasoningEffort: "low",
      maxOutputTokens: 512,
      timeoutMs: 1000,
      maxRetries: 0,
    },
    condition: "no_guidelines",
    limitEvals: 1,
    repetitions: 1,
    seed: "fixture-seed",
    maxRequests: 4,
    maxKnownCostUsd: 1,
    dryRun: false,
  };
}

it("starts hosted runs before inference and saves request/result/journal evidence without credentials", async () => {
  const calls: string[] = [];
  const blobs: Array<Record<string, unknown>> = [];
  const transport: DecisionTransport = {
    async action(name, args) {
      calls.push(name);
      expect(args.token).toBe("test-token");
      if (name === "decisionAdmin:start") return { runId: "run-fixture" };
      if (name === "decisionAdmin:generateUploadUrl")
        return "https://upload.invalid";
      if (name === "decisionAdmin:finish") return { status: "completed" };
      return null;
    },
    async upload(_url, bytes) {
      expect(uploadedText(bytes)).not.toContain("test-token");
      expect(uploadedText(bytes)).not.toContain("fake-provider-key");
      blobs.push(uploadedJson(bytes));
      return `storage-${blobs.length}`;
    },
  };
  const fetcher = Object.assign(
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push("inference");
      if (typeof init?.body !== "string")
        throw new Error("Expected a serialized request");
      const body = init.body;
      expect(body).not.toContain("correctOptionId");
      expect(body).not.toContain("rationale");
      return Response.json({
        model: "fixture-returned",
        choices: [
          { finish_reason: "stop", message: { content: '{"choice":"A"}' } },
        ],
        usage: { cost: 0 },
      });
    },
    { preconnect: () => undefined },
  );
  const target = decisionReportingTarget(environment, commit)!;
  const result = await runDecisions(
    fixture(),
    { fetcher },
    createDecisionReporter(target, "fixture", transport),
  );
  expect(calls[0]).toBe("decisionAdmin:start");
  expect(calls.indexOf("inference")).toBeGreaterThan(0);
  expect(calls.at(-1)).toBe("decisionAdmin:finish");
  expect(blobs.map((value) => value.kind)).toEqual([
    "decision-question",
    "decision-run",
  ]);
  expect(result.summary?.complete).toBe(true);
  expect(result.summary?.costUsd).toBe(0);
  const final = blobs.at(-1)!;
  expect(final.attemptStarts).toHaveLength(1);
  expect(final.attempts).toHaveLength(1);
  expect(final.resultEvidence).toHaveLength(1);
  expect(
    readFileSync(join(result.directory, "report.html"), "utf8"),
  ).not.toContain("This local trial");
});

it("does not call providers if the hosted run cannot be established", async () => {
  let providerCalls = 0;
  const transport: DecisionTransport = {
    action: async () => {
      throw new Error("Version not minted");
    },
    upload: async () => {
      throw new Error("Unexpected upload");
    },
  };
  const fetcher = Object.assign(
    async () => {
      providerCalls++;
      return Response.json({});
    },
    { preconnect: () => undefined },
  );
  const failure = await rejection(
    runDecisions(
      fixture(),
      { fetcher },
      createDecisionReporter(
        decisionReportingTarget(environment, commit)!,
        "fixture",
        transport,
        async () => {},
      ),
    ),
  );
  expect(failure.message).toContain("Version not minted");
  expect(providerCalls).toBe(0);
});

it("records Jev's OpenRouter route with unused chat settings null", async () => {
  const options = fixture();
  options.config.model = "typesafe/jev-1.13";
  let recorded: Record<string, unknown> | undefined;
  const transport: DecisionTransport = {
    async action(name, args) {
      if (name === "decisionAdmin:start") {
        recorded = args;
        return { runId: "jev-run" };
      }
      if (name === "decisionAdmin:generateUploadUrl")
        return "https://upload.invalid";
      return { status: "completed" };
    },
    async upload() {
      return "fixture-evidence";
    },
  };
  const fetcher = Object.assign(
    async () =>
      Response.json({
        model: "typesafe/jev-1.13-20260917",
        answers: {
          decision: {
            type: "choice",
            choice: "A",
            probabilities: { A: 1, B: 0, C: 0, D: 0 },
            confidence: 1,
          },
        },
        usage: { cost: 0.00001 },
      }),
    { preconnect: () => undefined },
  );
  const result = await runDecisions(
    options,
    { fetcher },
    createDecisionReporter(
      decisionReportingTarget(environment, commit)!,
      "jev-fixture",
      transport,
    ),
  );
  expect(result.summary?.complete).toBe(true);
  expect(recorded).toMatchObject({
    model: "typesafe/jev-1.13",
    profile: { reasoningEffort: null, maxOutputTokens: null },
  });
  expect(recorded).not.toHaveProperty("provider");
});

it("rejects a hosted TypeSafe route before creating a remote run or calling a provider", async () => {
  const options = fixture();
  options.config.provider = "typesafe";
  let remoteStart = false;
  let providerCalls = 0;
  const transport: DecisionTransport = {
    action: async () => {
      remoteStart = true;
      return { runId: "unexpected" };
    },
    upload: async () => "unexpected",
  };
  const fetcher = Object.assign(
    async () => {
      providerCalls++;
      return Response.json({});
    },
    { preconnect: () => undefined },
  );
  const failure = await rejection(
    runDecisions(
      options,
      { fetcher },
      createDecisionReporter(
        decisionReportingTarget(environment, commit)!,
        "typesafe-hosted-fixture",
        transport,
        async () => {},
      ),
    ),
  );
  expect(failure.message).toContain("OpenRouter provider");
  expect(remoteStart).toBe(false);
  expect(providerCalls).toBe(0);
});

it("reproduces the complete shared source hash, including binary lockfiles, and rejects tampering", () => {
  const snapshot = createDecisionSourceSnapshot(root, commit);
  expect(snapshot.banks).toHaveLength(90);
  expect(snapshot.files.some((file) => file.encoding === "base64")).toBe(true);
  expect(recomputeSnapshotBenchmark(snapshot)).toBe(snapshot.benchmark.version);
  const altered = structuredClone(snapshot);
  altered.files[0].content += "changed";
  expect(() => recomputeSnapshotBenchmark(altered)).toThrow();
  const missing = structuredClone(snapshot);
  missing.files = missing.files.filter(
    (file) => file.path !== "runner/models/guidelines.md",
  );
  expect(() => recomputeSnapshotBenchmark(missing)).toThrow("Missing source");
  const duplicate = structuredClone(snapshot);
  duplicate.files.push(duplicate.files[0]);
  expect(() => recomputeSnapshotBenchmark(duplicate)).toThrow(
    "Duplicate source",
  );
  for (const path of [
    "evals/category/omitted/.env.local",
    "evals/category/omitted/backend/state.db",
    "../credentials.json",
    "evals/category/omitted/id.key",
  ]) {
    expect(() => assertSafeSourcePath(path)).toThrow();
    const unsafe = structuredClone(snapshot);
    unsafe.files.push({ ...unsafe.files[0], path });
    expect(() => recomputeSnapshotBenchmark(unsafe)).toThrow();
  }
});

it("compacts and compresses full-bank journals within hosted evidence bounds", () => {
  const snapshot = createDecisionSourceSnapshot(root, commit);
  const guidelines = readFileSync(join(root, "runner/models/guidelines.md"), "utf8");
  const config = {
    provider: "openrouter" as const,
    model: "openai/gpt-5",
    reasoningEffort: "low" as const,
    maxOutputTokens: 2048,
    timeoutMs: 45_000,
    maxRetries: 0,
  };
  const planned = [];
  const attempts = [];
  const starts = [];
  for (let repetition = 0; repetition < 3; repetition++) {
    for (const bank of snapshot.banks) {
      for (const question of bank.questions) {
        const key = `${bank.sourceEval}/${question.id}/${repetition}`;
        const presented = presentQuestion(
          question,
          bank.sourceEval,
          "full-bank-size",
          repetition,
        );
        const request = buildProviderRequest(config, presented, guidelines);
        planned.push({ key, sourceEval: bank.sourceEval, repetition, question, presented });
        const attempt = {
          key, request, attempt: 1, startedAt: "2026-09-18T00:00:00.000Z",
          durationMs: 123, httpStatus: 200,
          response: { model: config.model, choices: [{ finish_reason: "stop",
            message: { content: '{"choice":"A"}' } }], usage: { cost: 0.001 } },
          error: null,
        };
        attempts.push(attempt);
        starts.push({ key, request, attempt: 1, startedAt: attempt.startedAt });
      }
    }
  }
  const base = {
    artifactVersion: 1, kind: "decision-run", runId: "fixture", clientRunKey: "fixture",
    origin: { kind: "development", sourceCommit: commit },
    manifest: { artifactVersion: 1, planned }, status: { kind: "completed" },
    finishedAt: "2026-09-18T00:01:00.000Z", durationMs: 60_000,
    resultEvidence: [],
  };
  const oldBytes = Buffer.byteLength(`${JSON.stringify({ ...base, attempts, attemptStarts: starts })}\n`);
  const compact = {
    ...base,
    attempts: attempts.map(compactDecisionJournalRow),
    attemptStarts: starts.map(compactDecisionJournalRow),
  };
  const compactJson = `${JSON.stringify(compact)}\n`;
  const compressed = encodeDecisionRunEvidence(compact);
  expect(oldBytes).toBeGreaterThan(8 * 1024 * 1024);
  expect(Buffer.byteLength(compactJson)).toBeLessThan(
    MAX_DECISION_RUN_EVIDENCE_DECOMPRESSED_BYTES,
  );
  expect(compressed.length).toBeLessThan(MAX_DECISION_RUN_EVIDENCE_COMPRESSED_BYTES);
  expect(JSON.parse(gunzipSync(compressed).toString("utf8"))).toEqual(compact);
  expect(compact.attempts[0]).not.toHaveProperty("request");
  expect(compact.attempts[0].requestSha256).toBe(
    createHash("sha256").update(canonicalJson(attempts[0].request)).digest("hex"),
  );

  // Exercise the actual maximum plan: 106 questions, ten repetitions, and
  // four attempts per slot. Each successful response is roughly 8,192 tokens,
  // while preceding retries carry independent failure evidence.
  const maxPlanned = [];
  const maxAttempts = [];
  const maxStarts = [];
  for (let repetition = 0; repetition < 10; repetition++) {
    for (const bank of snapshot.banks) {
      for (const question of bank.questions) {
        const key = `${bank.sourceEval}/${question.id}/${repetition}`;
        const presented = presentQuestion(
          question,
          bank.sourceEval,
          "full-bank-max-size",
          repetition,
        );
        const request = buildProviderRequest(
          { ...config, maxOutputTokens: 8192, maxRetries: 3 },
          presented,
          guidelines,
        );
        maxPlanned.push({
          key,
          sourceEval: bank.sourceEval,
          repetition,
          question,
          presented,
        });
        for (let attempt = 1; attempt <= 4; attempt++) {
          const startedAt = `2026-09-18T00:00:${String(attempt).padStart(2, "0")}.000Z`;
          maxStarts.push(
            compactDecisionJournalRow({ key, request, attempt, startedAt }),
          );
          const response =
            attempt === 4
              ? {
                  model: config.model,
                  choices: [
                    {
                      finish_reason: "length",
                      message: {
                        content: Array.from(
                          { length: 241 },
                          (_, line) =>
                            `Step ${line}: evaluate ${key}; branch ${(line * 37 + repetition) % 997}; preserve the exact TypeScript contract and explain the result.`,
                        ).join("\n"),
                      },
                    },
                  ],
                  usage: { cost: 0.1 },
                }
              : null;
          maxAttempts.push(
            compactDecisionJournalRow({
              key,
              request,
              attempt,
              startedAt,
              durationMs: 45_000,
              httpStatus: attempt === 4 ? 200 : 429,
              response,
              error: attempt === 4 ? null : `rate limited attempt ${attempt}`,
            }),
          );
        }
      }
    }
  }
  const stress = encodeDecisionRunEvidence({
    ...compact,
    manifest: { artifactVersion: 1, planned: maxPlanned },
    attempts: maxAttempts,
    attemptStarts: maxStarts,
  });
  expect(maxPlanned).toHaveLength(1060);
  expect(maxAttempts).toHaveLength(4240);
  expect(maxStarts).toHaveLength(4240);
  expect(
    Buffer.byteLength(
      (
        maxAttempts[3] as {
          response: { choices: Array<{ message: { content: string } }> };
        }
      ).response.choices[0].message.content,
    ),
  ).toBeGreaterThan(32 * 1024);
  expect(stress.length).toBeLessThan(MAX_DECISION_RUN_EVIDENCE_COMPRESSED_BYTES);
  expect(gunzipSync(stress).length).toBeLessThan(
    MAX_DECISION_RUN_EVIDENCE_DECOMPRESSED_BYTES,
  );
});

for (const mode of [
  "recover-record",
  "fail-record",
  "interrupted-finish",
] as const) {
  it(`handles ${mode} without repeating model inference or claiming a failed run completed`, async () => {
    let inferenceCalls = 0;
    const records: string[] = [];
    const blobs: Array<Record<string, unknown>> = [];
    const transport: DecisionTransport = {
      async action(name, args) {
        if (name === "decisionAdmin:start") return { runId: "run-fixture" };
        if (name === "decisionAdmin:generateUploadUrl")
          return "https://upload.invalid";
        if (name === "decisionAdmin:record") {
          records.push(JSON.stringify(args));
          if (
            mode === "fail-record" ||
            (mode === "recover-record" && records.length === 1)
          )
            throw new Error("record transport failure");
          return { inserted: 0, unchanged: 1 };
        }
        return {
          status: mode === "interrupted-finish" ? "interrupted" : "completed",
        };
      },
      async upload(_url, bytes) {
        blobs.push(uploadedJson(bytes));
        return `storage-${blobs.length}`;
      },
    };
    const fetcher = Object.assign(
      async () => {
        inferenceCalls++;
        return Response.json({
          choices: [
            { finish_reason: "stop", message: { content: '{"choice":"A"}' } },
          ],
          usage: { cost: 0.01 },
        });
      },
      { preconnect: () => undefined },
    );
    const promise = runDecisions(
      fixture(),
      { fetcher },
      createDecisionReporter(
        decisionReportingTarget(environment, commit)!,
        "fixture",
        transport,
        async () => {},
      ),
    );
    if (mode === "recover-record")
      expect((await promise).summary?.complete).toBe(true);
    else
      expect((await rejection(promise)).message).toContain(
        mode === "fail-record" ? "record transport failure" : "interrupted",
      );
    expect(inferenceCalls).toBe(1);
    expect(new Set(records).size).toBe(1);
    expect(records).toHaveLength(
      mode === "fail-record" ? 3 : mode === "recover-record" ? 2 : 1,
    );
    if (mode === "fail-record") {
      expect(blobs.at(-1)?.status).toMatchObject({
        kind: "incomplete",
        stopReason: "record transport failure",
      });
      expect(blobs.at(-1)?.resultEvidence).toHaveLength(0);
    }
  });
}
