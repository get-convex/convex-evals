import { convexTest } from "convex-test";
import { describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import schema from "./schema.js";
import { modules } from "./test.setup.js";
import { requireCodingRun, requireDecisionRun } from "./documentKinds.js";

async function fixture() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const benchmarkVersion = await ctx.db.insert("benchmarkVersions", {
      version: "mixed-consumer-fixture",
      effectiveAt: 1,
      evalCount: 1,
      curatedModels: [],
      provenance: "minted",
    });
    const modelId = await ctx.db.insert("models", {
      slug: "test/mixed-model",
      formattedName: "Mixed model",
      provider: "test",
      apiKind: "chat",
      openRouterFirstSeenAt: 1,
      createdAt: 1,
      updatedAt: 1,
      lastSeenAt: 1,
    });
    const legacyRun = await ctx.db.insert("runs", {
      kind: "coding",
      modelId,
      provider: "test",
      plannedEvals: ["cat/legacy"],
      benchmarkVersion,
      status: { kind: "running" },
    });
    const taggedRun = await ctx.db.insert("runs", {
      kind: "coding",
      modelId,
      provider: "test",
      plannedEvals: ["cat/tagged"],
      benchmarkVersion,
      status: { kind: "running" },
    });
    const decisionRun = await ctx.db.insert("runs", {
      kind: "decision",
      benchmarkVersion,
      runKey: "mixed-consumer-decision",
      model: "typesafe/jev-1.13",
      condition: "no_guidelines",
      profile: {
        reasoningEffort: null,
        maxOutputTokens: null,
        timeoutMs: 1_000,
        maxRetries: 0,
        seed: "fixture",
        repetitions: 1,
      },
      profileHash: "a".repeat(64),
      plannedQuestions: ["cat/task/q"],
      fullSuite: false,
      origin: { kind: "development", sourceCommit: null },
      status: "running",
    });
    const decisionEvidenceStorageId = await ctx.storage.store(new Blob(["{}"]));
    const decisionEval = await ctx.db.insert("evals", {
      kind: "decision",
      runId: decisionRun,
      questionKey: "cat/task/q",
      repetition: 0,
      outcome: "provider_error",
      selectedCanonicalId: null,
      correct: false,
      returnedModel: null,
      durationMs: 10,
      requestAttempts: 1,
      costUsd: null,
      knownCostUsd: 0,
      evidence: {
        storageId: decisionEvidenceStorageId,
        sha256: "b".repeat(64),
      },
    });
    const decisionScore = await ctx.db.insert("modelScores", {
      kind: "decision",
      benchmarkVersion,
      model: "typesafe/jev-1.13",
      condition: "no_guidelines",
      profileHash: "a".repeat(64),
      score: 0,
      scoreStdDev: 0,
      categoryScores: {},
      runCount: 1,
      plannedQuestions: 1,
      invalidResponses: 0,
      providerErrors: 1,
      averageRunDurationMs: 10,
      medianQuestionDurationMs: 10,
      p95QuestionDurationMs: 10,
      averageKnownRunCostUsd: 0,
      completeCostRunCount: 0,
      averageRunCostUsd: null,
      latestRunId: decisionRun,
      latestRunTime: 1,
    });
    const codingScore = await ctx.db.insert("modelScores", {
      kind: "coding",
      modelId,
      benchmarkVersion,
      totalScore: 1,
      totalScoreErrorBar: 0,
      averageRunDurationMs: 10,
      averageRunDurationMsErrorBar: 0,
      averageRunCostUsd: null,
      averageRunCostUsdErrorBar: null,
      scores: { cat: 1 },
      scoreErrorBars: { cat: 0 },
      runCount: 1,
      latestRunId: taggedRun,
      latestRunTime: 1,
    });
    return {
      modelId,
      legacyRun,
      taggedRun,
      decisionRun,
      decisionEval,
      decisionScore,
      codingScore,
      decisionEvidenceStorageId,
    };
  });
  return { t, ids };
}

describe("coding consumers over shared tables", () => {
  it("filters decision runs before applying the coding list limit", async () => {
    const { t, ids } = await fixture();
    const newest = await t.query(api.runs.listRuns, { limit: 1 });
    expect(newest).toHaveLength(1);
    expect(newest[0]._id).toBe(ids.taggedRun);
    expect(newest[0]).not.toHaveProperty("kind");

    const codingRuns = await t.query(api.runs.listRuns, { limit: 10 });
    expect(codingRuns.map((run) => run._id)).toEqual([
      ids.taggedRun,
      ids.legacyRun,
    ]);
  });

  it("rejects decision IDs at coding write boundaries", async () => {
    const { t, ids } = await fixture();
    await expect(
      t.mutation(internal.evals.createEval, {
        runId: ids.decisionRun,
        evalPath: "cat/wrong-kind",
        category: "cat",
        name: "wrong-kind",
      }),
    ).rejects.toThrow("coding run");
    await expect(
      t.mutation(internal.steps.recordStep, {
        evalId: ids.decisionEval,
        name: "tests",
        status: { kind: "running" },
      }),
    ).rejects.toThrow("coding eval");
    await expect(
      t.mutation(internal.runs.completeRun, {
        runId: ids.decisionRun,
        status: { kind: "completed", durationMs: 1 },
      }),
    ).rejects.toThrow("coding run");
  });

  it("preserves decision score rows during a coding cache rebuild", async () => {
    const { t, ids } = await fixture();
    const result = await t.mutation(
      internal.modelScores.rebuildAllModelScores,
      {},
    );
    expect(result.deleted).toBe(1);
    const decisionScore = await t.run((ctx) =>
      ctx.db.get("modelScores", ids.decisionScore),
    );
    expect(decisionScore).toMatchObject({ kind: "decision" });
  });

  it("refuses to cascade-delete across a corrupted kind boundary", async () => {
    const { t, ids } = await fixture();
    await t.run((ctx) =>
      ctx.db.patch("evals", ids.decisionEval, { runId: ids.taggedRun }),
    );
    await expect(
      t.mutation(internal.runs.deleteRun, { runId: ids.taggedRun }),
    ).rejects.toThrow("has decision result");
    const [run, result] = await t.run(async (ctx) =>
      Promise.all([
        ctx.db.get("runs", ids.taggedRun),
        ctx.db.get("evals", ids.decisionEval),
      ]),
    );
    expect(run).not.toBeNull();
    expect(result).not.toBeNull();
  });

  it("dispatches decision deletion through the decision cleanup", async () => {
    const { t, ids } = await fixture();
    await t.mutation(internal.runs.deleteRun, { runId: ids.decisionRun });
    const [run, result, evidence] = await t.run(async (ctx) =>
      Promise.all([
        ctx.db.get("runs", ids.decisionRun),
        ctx.db.get("evals", ids.decisionEval),
        ctx.storage.get(ids.decisionEvidenceStorageId),
      ]),
    );
    expect(run).toBeNull();
    expect(result).toBeNull();
    expect(evidence).toBeNull();
  });

  it("interrupts stale decision runs without writing a coding status", async () => {
    const { t, ids } = await fixture();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 4 * 60 * 60 * 1_000);
      await t.mutation(internal.runMaintenance.failStuckRuns, {});
    } finally {
      vi.useRealTimers();
    }
    const [codingRun, decisionRun] = await t.run(async (ctx) =>
      Promise.all([
        ctx.db.get("runs", ids.taggedRun),
        ctx.db.get("runs", ids.decisionRun),
      ]),
    );
    if (!codingRun || !decisionRun) throw new Error("Missing fixture runs");
    expect(requireCodingRun(codingRun).status).toMatchObject({
      kind: "failed",
    });
    expect(requireDecisionRun(decisionRun).status).toBe("interrupted");
    expect(requireDecisionRun(decisionRun)).toMatchObject({
      kind: "decision",
      failureReason: expect.stringContaining("maintenance timeout"),
      summary: { costUsd: null },
    });
  });
});
