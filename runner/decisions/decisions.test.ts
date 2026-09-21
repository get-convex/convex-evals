import { afterEach, describe, expect, it } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { computeBenchmarkDefinition } from "../benchmark.js";
import { computeDecisionBenchmarkDefinition } from "./source.js";
import {
  buildProviderRequest,
  callProvider,
  parseProviderResponse,
  providerEndpoint,
  type ProviderOutcome,
} from "./providers.js";
import {
  loadQuestionBanks,
  presentQuestion,
  questionBankSchema,
  sourceFingerprint,
  type QuestionBank,
} from "./questions.js";
import { buildRunPlan, runDecisions, type DecisionRunOptions } from "./run.js";
import {
  gradeQuestion,
  summarizeResults,
  type PlannedQuestion,
} from "./scoring.js";
import {
  parseDecisionManifest,
  parseQuestionResults,
  reconcileAttemptJournal,
  writeReport,
  type DecisionAttemptRecord,
} from "./report.js";
import { z } from "zod";
import type { ProviderConfig } from "./protocol.js";
import { regradeRun } from "./regrade.js";
import { readDecisionDefinition } from "./coverage.js";

const directories: string[] = [];
afterEach(() =>
  directories
    .splice(0)
    .forEach((path) => rmSync(path, { recursive: true, force: true })),
);
const config: ProviderConfig = {
  provider: "openrouter",
  model: "test-model",
  reasoningEffort: "low",
  maxOutputTokens: 512,
  timeoutMs: 1000,
  maxRetries: 1,
};
const bank: QuestionBank = {
  version: 1,
  sourceEval: "000-fundamentals/000-fixture",
  coverageNotes: "AUTHOR_ONLY_COVERAGE",
  questions: [
    {
      id: "private-question-id",
      concept: "AUTHOR_ONLY_CONCEPT",
      context: "A mutation writes a document.",
      question: "Which result is atomic?",
      options: [
        {
          id: "canonical-a",
          text: "Option one",
          rationale: "AUTHOR_ONLY_RATIONALE_ONE",
        },
        {
          id: "canonical-b",
          text: "Option two",
          rationale: "AUTHOR_ONLY_RATIONALE_TWO",
        },
        {
          id: "canonical-c",
          text: "Option three",
          rationale: "AUTHOR_ONLY_RATIONALE_THREE",
        },
        {
          id: "canonical-d",
          text: "Option four",
          rationale: "AUTHOR_ONLY_RATIONALE_FOUR",
        },
      ],
      correctOptionId: "canonical-b",
      sourceReferences: ["TASK.txt"],
    },
  ],
};
const question = bank.questions[0];
const presented = presentQuestion(question, bank.sourceEval, "test-seed", 0);

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "convex-decision-test-"));
  directories.push(root);
  const evalDirectory = join(root, "evals", bank.sourceEval);
  mkdirSync(evalDirectory, { recursive: true });
  mkdirSync(join(root, "runner/models"), { recursive: true });
  writeFileSync(join(evalDirectory, "TASK.txt"), "Task source");
  writeFileSync(join(evalDirectory, "questions.json"), JSON.stringify(bank));
  writeFileSync(
    join(root, "runner/models/guidelines.md"),
    "Fixture guidelines",
  );
  const envFile = join(root, "test.env");
  writeFileSync(
    envFile,
    "OPENROUTER_API_KEY=fixture-secret\nCONVEX_DEPLOY_KEY=must-not-use\nCONVEX_URL=https://must-not-contact.invalid\n",
  );
  const options: DecisionRunOptions = {
    projectRoot: root,
    outputRoot: join(root, "output"),
    config,
    condition: "no_guidelines",
    limitEvals: 10,
    repetitions: 1,
    seed: "test-seed",
    maxRequests: 5,
    maxKnownCostUsd: 1,
    envFile,
    dryRun: false,
  };
  return { root, evalDirectory, options };
}
function llmResponse(choice = "A", cost: number | undefined = 0.001) {
  return {
    model: "actual-model",
    choices: [
      {
        finish_reason: "stop",
        message: { content: JSON.stringify({ choice }) },
      },
    ],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 5,
      ...(cost === undefined ? {} : { cost }),
    },
  };
}
function mockFetch(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  return ((url: string | URL | Request, init?: RequestInit) =>
    handler(
      typeof url === "string" ? url : url instanceof URL ? url.href : url.url,
      init ?? {},
    )) as typeof fetch;
}
function planned(sourceEval: string, id: string): PlannedQuestion {
  return {
    key: `${sourceEval}/${id}/0`,
    sourceEval,
    repetition: 0,
    question: { ...question, id },
    presented,
  };
}
function outcome(choice: string): ProviderOutcome {
  const raw = llmResponse(choice);
  return {
    kind: "answered",
    answer: parseProviderResponse(config, raw, ["A", "B", "C", "D"]),
    error: null,
    attempts: [
      {
        attempt: 1,
        startedAt: "2026-01-01T00:00:00Z",
        durationMs: 5,
        httpStatus: 200,
        response: raw,
        error: null,
      },
    ],
    durationMs: 5,
  };
}

describe("question contracts and provenance", () => {
  it("accepts reviewed omissions while rejecting deleted banks and changed source evidence", () => {
    const { root, evalDirectory, options } = fixture();
    const omitted = "001-other/001-retired";
    mkdirSync(join(root, "evals", omitted), { recursive: true });
    writeFileSync(
      join(root, "evals", omitted, "TASK.txt"),
      "Unconverted coding task",
    );
    const manifest = {
      schemaVersion: 1,
      codingEvalCount: 2,
      banks: [
        {
          sourceEval: bank.sourceEval,
          questionIds: [question.id],
          sourceFingerprint: sourceFingerprint(evalDirectory),
          bankSha256: createHash("sha256")
            .update(readFileSync(join(evalDirectory, "questions.json")))
            .digest("hex"),
        },
      ],
      omittedSources: [
        {
          sourceEval: omitted,
          coverageLimits: ["Coding implementation remains unconverted"],
          decisions: [
            { id: "retired", reason: "Duplicate recognition target" },
          ],
        },
      ],
    };
    const manifestFile = join(root, "decision-bank.json");
    writeFileSync(manifestFile, JSON.stringify(manifest));
    expect(buildRunPlan(options).fullSuite).toBe(true);
    expect(buildRunPlan(options).decisionDefinition?.questionCount).toBe(1);
    const before = computeDecisionBenchmarkDefinition(root).version;
    writeFileSync(
      manifestFile,
      JSON.stringify({
        ...manifest,
        omittedSources: [
          { ...manifest.omittedSources[0], coverageLimits: ["Updated scope"] },
        ],
      }),
    );
    expect(computeDecisionBenchmarkDefinition(root).version).not.toBe(before);
    writeFileSync(
      join(evalDirectory, "TASK.txt"),
      "Different coding knowledge",
    );
    expect(() => buildRunPlan(options)).toThrow(
      "Reviewed coding source changed",
    );
    writeFileSync(join(evalDirectory, "TASK.txt"), "Task source");
    rmSync(join(evalDirectory, "questions.json"));
    expect(() => buildRunPlan(options)).toThrow("Question banks differ");
  });
  it("does not treat an unreviewed or filtered bank as a complete release", () => {
    const { root, evalDirectory, options } = fixture();
    expect(buildRunPlan(options).fullSuite).toBe(false);
    const second = "001-other/001-second";
    const secondDirectory = join(root, "evals", second);
    mkdirSync(secondDirectory, { recursive: true });
    writeFileSync(join(secondDirectory, "TASK.txt"), "Second source");
    writeFileSync(
      join(secondDirectory, "questions.json"),
      JSON.stringify({ ...bank, sourceEval: second }),
    );
    writeFileSync(
      join(root, "decision-bank.json"),
      JSON.stringify({
        schemaVersion: 1,
        codingEvalCount: 2,
        omittedSources: [],
        banks: [bank.sourceEval, second].map((sourceEval) => ({
          sourceEval,
          questionIds: [question.id],
          sourceFingerprint: sourceFingerprint(join(root, "evals", sourceEval)),
          bankSha256: createHash("sha256")
            .update(
              readFileSync(join(root, "evals", sourceEval, "questions.json")),
            )
            .digest("hex"),
        })),
      }),
    );
    expect(buildRunPlan(options).fullSuite).toBe(true);
    expect(buildRunPlan({ ...options, limitEvals: 1 }).fullSuite).toBe(false);
    writeFileSync(
      join(evalDirectory, "questions.json"),
      JSON.stringify({
        ...bank,
        questions: [{ ...question, question: "Changed deciding condition" }],
      }),
    );
    expect(
      readDecisionDefinition(root, loadQuestionBanks(root)).errors,
    ).toContain("Reviewed question content changed: " + bank.sourceEval);
  });
  it("rejects duplicate options, answer keys and question IDs", () => {
    expect(questionBankSchema.safeParse(bank).success).toBe(true);
    for (const changed of [
      { ...question, correctOptionId: "absent" },
      {
        ...question,
        options: [
          question.options[0],
          question.options[0],
          ...question.options.slice(2),
        ],
      },
    ])
      expect(
        questionBankSchema.safeParse({ ...bank, questions: [changed] }).success,
      ).toBe(false);
    expect(
      questionBankSchema.safeParse({ ...bank, questions: [question, question] })
        .success,
    ).toBe(false);
  });
  it("reports missing banks and rejects mismatched sources and escaped references", () => {
    const { root, evalDirectory } = fixture();
    const missing = join(root, "evals/001-other/001-missing");
    mkdirSync(missing, { recursive: true });
    writeFileSync(join(missing, "TASK.txt"), "Another task");
    expect(loadQuestionBanks(root).missing).toEqual(["001-other/001-missing"]);
    writeFileSync(
      join(evalDirectory, "questions.json"),
      JSON.stringify({ ...bank, sourceEval: "000-wrong/000-source" }),
    );
    expect(loadQuestionBanks(root).errors[0]).toContain("sourceEval must be");
    writeFileSync(
      join(evalDirectory, "questions.json"),
      JSON.stringify({
        ...bank,
        questions: [{ ...question, sourceReferences: ["../../../test.env"] }],
      }),
    );
    expect(loadQuestionBanks(root).errors[0]).toContain(
      "invalid or missing source reference",
    );
  });
  it("keeps coding identity independent of decision questions and implementation", () => {
    const { root, evalDirectory, options } = fixture();
    const before = computeBenchmarkDefinition(
      [`evals/${bank.sourceEval}`],
      root,
    );
    const decisionBefore = buildRunPlan(options).benchmark;
    expect(decisionBefore.version).not.toBe(before.version);
    const sourceBefore = sourceFingerprint(evalDirectory);
    writeFileSync(
      join(evalDirectory, "questions.json"),
      JSON.stringify({ ...bank, coverageNotes: "Revised question coverage" }),
    );
    const changedQuestion = computeBenchmarkDefinition(
      [`evals/${bank.sourceEval}`],
      root,
    );
    expect(changedQuestion.version).toBe(before.version);
    expect(buildRunPlan(options).benchmark.version).not.toBe(
      decisionBefore.version,
    );
    expect(sourceFingerprint(evalDirectory)).toBe(sourceBefore);
    mkdirSync(join(root, "runner/decisions"), { recursive: true });
    writeFileSync(
      join(root, "runner/decisions/protocol.ts"),
      "Changed decision protocol",
    );
    expect(
      computeBenchmarkDefinition([`evals/${bank.sourceEval}`], root).version,
    ).toBe(changedQuestion.version);
    writeFileSync(join(evalDirectory, "TASK.txt"), "Changed source task");
    expect(sourceFingerprint(evalDirectory)).not.toBe(sourceBefore);
  });
});

describe("provider boundaries", () => {
  it("accepts observed two-decimal probability rounding without normalizing it", () => {
    const native = {
      model: "jev-1.13.0",
      answers: {
        decision: {
          type: "choice",
          choice: "A",
          confidence: 0.9,
          probabilities: { A: 0.93, B: 0.05, C: 0.01, D: 0 },
        },
      },
    };
    const nativeConfig = { ...config, provider: "typesafe" as const };
    for (const probability of [0.92, 0.93, 0.95, 0.96]) {
      native.answers.decision.probabilities.A = probability;
      const parsed = parseProviderResponse(nativeConfig, native, [
        "A",
        "B",
        "C",
        "D",
      ]);
      expect(parsed.probabilities).toEqual(
        native.answers.decision.probabilities,
      );
    }
    native.answers.decision.probabilities.A = 0.91;
    expect(() =>
      parseProviderResponse(nativeConfig, native, ["A", "B", "C", "D"]),
    ).toThrow("sum to one");
    native.answers.decision.probabilities.A = 0.97;
    expect(() =>
      parseProviderResponse(nativeConfig, native, ["A", "B", "C", "D"]),
    ).toThrow("sum to one");
    native.answers.decision.probabilities.A = 0.934;
    expect(() =>
      parseProviderResponse(nativeConfig, native, ["A", "B", "C", "D"]),
    ).toThrow("sum to one");
  });
  it("reproduces permutations and never sends author-only fields", () => {
    expect(presentQuestion(question, bank.sourceEval, "test-seed", 0)).toEqual(
      presented,
    );
    const answers = new Set(
      Array.from(
        { length: 32 },
        (_, repeat) =>
          presentQuestion(question, bank.sourceEval, "test-seed", repeat)
            .expectedDisplayId,
      ),
    );
    expect(answers.size).toBe(4);
    for (const provider of ["typesafe", "openrouter"] as const) {
      const request = buildProviderRequest(
        { ...config, provider },
        presented,
        "Guidelines",
      );
      const payload = JSON.stringify(request);
      expect(payload).toContain("Guidelines");
      for (const secret of [
        "AUTHOR_ONLY",
        "canonical-",
        "sourceReferences",
        "correctOptionId",
        bank.sourceEval,
        question.id,
      ])
        expect(payload).not.toContain(secret);
    }
    expect(presented.displayToCanonical[presented.expectedDisplayId]).toBe(
      question.correctOptionId,
    );
  });
  it("parses native TypeSafe distributions without inventing cost", () => {
    const tsConfig = { ...config, provider: "typesafe" as const };
    const raw = {
      model: "jev-fixture",
      answers: {
        decision: {
          type: "choice",
          choice: "A",
          probabilities: { A: 0.7, B: 0.1, C: 0.1, D: 0.1 },
          confidence: 0.4,
        },
      },
      usage: { input_tokens: 10, output_tokens: 4 },
    };
    expect(
      parseProviderResponse(tsConfig, raw, ["A", "B", "C", "D"]).costUsd,
    ).toBeNull();
    expect(
      parseProviderResponse(tsConfig, raw, ["A", "B", "C", "D"]).confidence,
    ).toBe(0.4);
    raw.answers.decision.choice = "B";
    expect(() =>
      parseProviderResponse(tsConfig, raw, ["A", "B", "C", "D"]),
    ).toThrow("highest-probability");
    raw.answers.decision.choice = "A";
    raw.answers.decision.probabilities.A = 0.8;
    expect(() =>
      parseProviderResponse(tsConfig, raw, ["A", "B", "C", "D"]),
    ).toThrow("sum to one");
  });
  it("routes Jev through OpenRouter's native Decisions API and preserves billed usage", async () => {
    const routed = { ...config, model: "typesafe/jev-1.13" };
    const request = buildProviderRequest(routed, presented, "");
    const direct = buildProviderRequest(
      { ...routed, provider: "typesafe" },
      presented,
      "",
    );
    expect(request).toEqual(direct);
    expect(request).not.toHaveProperty("messages");
    expect(request).not.toHaveProperty("reasoning");
    expect(request).not.toHaveProperty("max_tokens");
    const raw = {
      model: "typesafe/jev-1.13-20260917",
      answers: {
        decision: {
          type: "choice",
          choice: "B",
          probabilities: { C: 0, A: 0.02, B: 0.98, D: 0 },
          confidence: 0.97,
        },
      },
      usage: { input_tokens: 609, output_tokens: 45, cost: 0.000025578 },
    };
    const outcome = await callProvider(routed, request, "fixture-key", {
      fetcher: mockFetch((url) => {
        expect(url).toBe("https://openrouter.ai/api/alpha/decisions");
        return Response.json(raw);
      }),
    });
    expect(outcome.kind).toBe("answered");
    expect(outcome.answer).toMatchObject({
      choice: "B",
      probabilities: raw.answers.decision.probabilities,
      confidence: 0.97,
      costUsd: 0.000025578,
      returnedModel: raw.model,
    });
    expect(providerEndpoint({ ...routed, model: "~typesafe/jev-latest" })).toBe(
      "https://openrouter.ai/api/alpha/decisions",
    );
    expect(providerEndpoint(config)).toBe(
      "https://openrouter.ai/api/v1/chat/completions",
    );
    expect(
      parseProviderResponse(routed, { ...raw, usage: { input_tokens: 609 } }, [
        "A",
        "B",
        "C",
        "D",
      ]).costUsd,
    ).toBeNull();
  });
  it("retries transient failures but never re-asks a valid wrong answer or malformed answer", async () => {
    let calls = 0;
    const retry = await callProvider(config, {}, "fixture-secret", {
      fetcher: mockFetch(() =>
        ++calls === 1
          ? new Response("busy", {
              status: 429,
              headers: { "retry-after": "0" },
            })
          : Response.json(llmResponse()),
      ),
      sleep: async () => {},
    });
    expect(calls).toBe(2);
    expect(retry.kind).toBe("answered");
    expect(retry.attempts).toHaveLength(2);
    for (const raw of [llmResponse("Z"), llmResponse("D")]) {
      calls = 0;
      const result = await callProvider(config, {}, "fixture-secret", {
        fetcher: mockFetch(() => {
          calls++;
          return Response.json(raw);
        }),
      });
      expect(calls).toBe(1);
      expect(result.kind).toBe(
        raw.choices[0].message.content.includes('"Z"')
          ? "invalid_response"
          : "answered",
      );
    }
  });
  it("rejects truncated and extra-field LLM answers", () => {
    const truncated = llmResponse();
    truncated.choices[0].finish_reason = "length";
    expect(() =>
      parseProviderResponse(config, truncated, ["A", "B", "C", "D"]),
    ).toThrow("Incomplete answer");
    const extra = llmResponse();
    extra.choices[0].message.content = '{"choice":"A","reason":"not allowed"}';
    expect(() =>
      parseProviderResponse(config, extra, ["A", "B", "C", "D"]),
    ).toThrow("Unexpected");
  });
});

describe("scoring and local execution", () => {
  it("regrades raw responses offline with immutable sources and explicit provenance", async () => {
    const { root, options } = fixture();
    const run = await runDecisions(options, {
      fetcher: mockFetch(() =>
        Response.json(llmResponse(presented.expectedDisplayId)),
      ),
    });
    const resultFile = join(run.directory, "results.jsonl");
    const saved = parseQuestionResults(readFileSync(resultFile, "utf8"))[0];
    saved.kind = "invalid_response";
    saved.correct = false;
    saved.outcome.kind = "invalid_response";
    saved.outcome.answer = null;
    saved.outcome.error = "Old parser rejection";
    writeFileSync(resultFile, JSON.stringify(saved) + "\n");
    const before = Object.fromEntries(
      ["manifest.json", "attempts.jsonl", "results.jsonl"].map((name) => [
        name,
        readFileSync(join(run.directory, name), "utf8"),
      ]),
    );
    mkdirSync(join(root, "runner/decisions"), { recursive: true });
    writeFileSync(
      join(root, "runner/decisions/protocol.ts"),
      "Changed parser policy fingerprint",
    );
    const replay = regradeRun(
      run.directory,
      root,
      join(root, "regraded"),
      "Parser fix",
    );
    expect(replay.summary.score).toBe(1);
    expect(replay.provenance.networkRequests).toBe(0);
    expect(replay.provenance.reclassifiedResults[0]?.originalError).toBe(
      "Old parser rejection",
    );
    const revised = parseDecisionManifest(
      readFileSync(join(replay.directory, "manifest.json"), "utf8"),
    );
    expect(revised.benchmark.version).toBe(
      revised.provenance!.sourceBenchmark.version,
    );
    for (const [name, content] of Object.entries(before))
      expect(readFileSync(join(run.directory, name), "utf8")).toBe(content);
  });
  it("refuses offline regrading when a question or provider context changed", async () => {
    const { root, evalDirectory, options } = fixture();
    const run = await runDecisions(
      { ...options, condition: "with_guidelines" },
      { fetcher: mockFetch(() => Response.json(llmResponse())) },
    );
    writeFileSync(
      join(root, "runner/models/guidelines.md"),
      "Different supplied context",
    );
    expect(() =>
      regradeRun(run.directory, root, join(root, "regraded"), "Test"),
    ).toThrow("Provider payload changed");
    writeFileSync(
      join(root, "runner/models/guidelines.md"),
      "Fixture guidelines",
    );
    writeFileSync(
      join(evalDirectory, "questions.json"),
      JSON.stringify({
        ...bank,
        questions: [{ ...question, correctOptionId: "canonical-a" }],
      }),
    );
    expect(() =>
      regradeRun(run.directory, root, join(root, "regraded"), "Test"),
    ).toThrow("Questions, keys, or presentations changed");
  });
  it("preserves orphaned HTTP attempts when rebuilding an interrupted report", async () => {
    const { options } = fixture();
    const result = await runDecisions(options, {
      fetcher: mockFetch(() =>
        Response.json(llmResponse(presented.expectedDisplayId)),
      ),
    });
    // Simulate termination after the attempt was journaled but before its
    // per-question record reached disk. The question remains ungraded.
    writeFileSync(join(result.directory, "results.jsonl"), "");
    const summary = writeReport(result.directory);
    expect(summary.complete).toBe(false);
    expect(summary.score).toBe(0);
    expect(summary.requestAttempts).toBe(1);
    expect(summary.costUsd).toBe(0.001);
  });
  it("keeps unfinished requests unknown through reporting and offline regrading", async () => {
    const { root, options } = fixture();
    const result = await runDecisions(
      { ...options, repetitions: 2 },
      { fetcher: mockFetch(() => Response.json(llmResponse())) },
    );
    // Model termination during request two: its start reached disk, while its
    // HTTP completion and terminal question result did not.
    for (const name of ["attempts.jsonl", "results.jsonl"]) {
      const path = join(result.directory, name);
      writeFileSync(
        path,
        readFileSync(path, "utf8").trim().split("\n")[0] + "\n",
      );
    }
    const startsPath = join(result.directory, "attempt-starts.jsonl");
    const starts = readFileSync(startsPath, "utf8");
    const summary = writeReport(result.directory);
    expect(summary.complete).toBe(false);
    expect(summary.requestAttempts).toBe(2);
    expect(summary.costComplete).toBe(false);
    expect(summary.costUsd).toBeNull();
    expect(summary.knownCostUsd).toBe(0.001);

    const replay = regradeRun(
      result.directory,
      root,
      join(root, "regraded"),
      "Recheck saved responses",
    );
    expect(
      readFileSync(join(replay.directory, "attempt-starts.jsonl"), "utf8"),
    ).toBe(starts);
    expect(replay.provenance.sourceAttemptStartsSha256).toBe(
      createHash("sha256").update(starts).digest("hex"),
    );
    expect(replay.summary.requestAttempts).toBe(2);
    expect(replay.summary.costUsd).toBeNull();
    expect(replay.summary.knownCostUsd).toBe(0.001);

    // Old artifacts cannot tell us about requests whose response was lost, but
    // remain readable using the evidence they actually recorded.
    rmSync(startsPath);
    const legacy = writeReport(result.directory);
    expect(legacy.requestAttempts).toBe(1);
    expect(legacy.costUsd).toBe(0.001);
    const legacyReplay = regradeRun(
      result.directory,
      root,
      join(root, "legacy-regraded"),
      "Legacy artifact",
    );
    expect(legacyReplay.summary.requestAttempts).toBe(1);
    expect(legacyReplay.summary.costUsd).toBe(0.001);
  });
  it("rejects duplicate or mismatched request journal identities", () => {
    const item = planned(bank.sourceEval, question.id);
    const complete: DecisionAttemptRecord = {
      ...outcome("A").attempts[0],
      key: item.key,
      request: { message: "same request" },
    };
    const start: DecisionAttemptRecord = {
      ...complete,
      durationMs: 0,
      httpStatus: null,
      response: null,
      error: null,
    };
    expect(reconcileAttemptJournal([item], [complete], [start])).toEqual([
      complete,
    ]);
    expect(() =>
      reconcileAttemptJournal([item], [complete, complete], [start]),
    ).toThrow("Duplicate completed");
    expect(() =>
      reconcileAttemptJournal([item], [complete], [start, start]),
    ).toThrow("Duplicate started");
    expect(() => reconcileAttemptJournal([item], [complete], [])).toThrow(
      "no matching start",
    );
    expect(() =>
      reconcileAttemptJournal(
        [item],
        [{ ...complete, request: { message: "different" } }],
        [start],
      ),
    ).toThrow("start/completion mismatch");
    expect(() =>
      reconcileAttemptJournal(
        [item],
        [{ ...complete, startedAt: "2026-01-02T00:00:00Z" }],
        [start],
      ),
    ).toThrow("start/completion mismatch");
    expect(() =>
      reconcileAttemptJournal([item], [], [{ ...start, key: "unplanned" }]),
    ).toThrow("Unplanned started");
    expect(() =>
      reconcileAttemptJournal([item], [], [{ ...start, attempt: 0 }]),
    ).toThrow("Invalid attempt ID");
    expect(() =>
      reconcileAttemptJournal([item], [], [{ ...start, attempt: 2 }]),
    ).toThrow("Nonsequential");
  });
  it("weights source evals equally and keeps unanswered questions in the denominator", () => {
    const items = [
      planned("000/a", "q1"),
      planned("000/b", "q1"),
      planned("000/b", "q2"),
      planned("000/b", "q3"),
    ];
    const result = gradeQuestion(
      items[0],
      outcome(presented.expectedDisplayId),
    );
    const summary = summarizeResults(items, [result]);
    expect(summary.score).toBe(0.5);
    expect(summary.questionAccuracy).toBe(0.25);
    expect(summary.complete).toBe(false);
    expect(summary.missingQuestions).toBe(3);
    expect(() => summarizeResults(items, [result, result])).toThrow(
      "Duplicate result",
    );
  });
  it("dry-runs without keys or network and snapshots the full request plan", async () => {
    const { options } = fixture();
    const result = await runDecisions(
      { ...options, envFile: undefined, dryRun: true },
      {
        fetcher: mockFetch(() => {
          throw new Error("Unexpected network");
        }),
      },
    );
    expect(result.dryRun).toBe(true);
    expect(
      readFileSync(join(result.directory, "requests.jsonl"), "utf8"),
    ).not.toContain("AUTHOR_ONLY");
    expect(
      z
        .object({ networkRequests: z.number() })
        .parse(
          JSON.parse(
            readFileSync(join(result.directory, "status.json"), "utf8"),
          ),
        ).networkRequests,
    ).toBe(0);
  });
  it("runs only against the selected provider and regenerates scores from saved choices", async () => {
    const { options } = fixture();
    const result = await runDecisions(options, {
      fetcher: mockFetch((url, init) => {
        expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
        expect(init.redirect).toBe("error");
        expect(JSON.stringify(init.body)).not.toContain("AUTHOR_ONLY");
        return Response.json(llmResponse(presented.expectedDisplayId));
      }),
    });
    expect(result.summary?.score).toBe(1);
    expect(result.summary?.costUsd).toBe(0.001);
    const file = join(result.directory, "results.jsonl");
    const saved = parseQuestionResults(readFileSync(file, "utf8"))[0];
    saved.correct = false;
    writeFileSync(file, JSON.stringify(saved) + "\n");
    expect(writeReport(result.directory).score).toBe(1);
    for (const name of [
      "manifest.json",
      "attempts.jsonl",
      "results.jsonl",
      "report.html",
    ]) {
      const contents = readFileSync(join(result.directory, name), "utf8");
      expect(contents).not.toContain("fixture-secret");
      expect(contents).not.toContain("must-not-use");
      expect(contents).not.toContain("must-not-contact");
    }
  });
  it("labels hosted reports with their actual scope without claiming publication", async () => {
    const { options } = fixture();
    for (const scope of ["github-actions", "development"] as const) {
      const result = await runDecisions(
        options,
        { fetcher: mockFetch(() => Response.json(llmResponse())) },
        {
          metadata: {
            scope,
            sourceCommit: "a".repeat(40),
            runnerLocation: scope,
          },
          onStart: async () => {},
          onResult: async () => {},
          onFinish: async () => {},
        },
      );
      const html = readFileSync(join(result.directory, "report.html"), "utf8");
      expect(html).toContain(
        scope === "github-actions" ? "GitHub Actions run" : "Development run",
      );
      expect(html).toContain("minted benchmark");
      expect(html).not.toContain("unminted");
      expect(html).not.toContain("This local trial");
      expect(html).toContain(
        scope === "github-actions"
          ? "publication depends on successful ingestion"
          : "do not appear on the production leaderboard",
      );
    }
  });
  it("counts retry attempts against the hard cap and preserves the interrupted attempt", async () => {
    const { options } = fixture();
    let requests = 0;
    const result = await runDecisions(
      { ...options, maxRequests: 1 },
      {
        fetcher: mockFetch(() => {
          requests++;
          return new Response("unavailable", { status: 503 });
        }),
        sleep: async () => {},
      },
    );
    expect(requests).toBe(1);
    expect(result.summary?.requestAttempts).toBe(1);
    expect(result.summary?.providerErrors).toBe(1);
    expect(result.summary?.score).toBe(0);
    expect(result.summary?.costUsd).toBeNull();
    expect(
      z
        .object({ stopReason: z.string().nullable() })
        .parse(
          JSON.parse(
            readFileSync(join(result.directory, "status.json"), "utf8"),
          ),
        ).stopReason,
    ).toBe("Request budget reached");
  });
  it("stops after authentication failure or observed spend with partial denominator intact", async () => {
    const { options } = fixture();
    for (const status of [401, 200]) {
      let requests = 0;
      const result = await runDecisions(
        { ...options, repetitions: 3, maxKnownCostUsd: 0.01 },
        {
          fetcher: mockFetch(() => {
            requests++;
            return status === 401
              ? new Response("denied", { status })
              : Response.json(llmResponse(presented.expectedDisplayId, 0.02));
          }),
        },
      );
      expect(requests).toBe(1);
      expect(result.summary?.complete).toBe(false);
      expect(result.summary?.plannedQuestions).toBe(3);
      expect(result.summary?.completedQuestions).toBe(1);
    }
  });
});
