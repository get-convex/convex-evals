import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { internal } from "./_generated/api.js";
import schema from "./schema.js";
import { modules } from "./test.setup.js";
import { requireCodingRun, requireDecisionRun } from "./documentKinds.js";
import type { FunctionReturnType } from "convex/server";
import {
  AUDIT_MAX_PAGE_BYTES,
  boundedAuditPagination,
  cachedAuditRead,
} from "./migrations.js";

async function fixture() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const benchmarkVersion = await ctx.db.insert("benchmarkVersions", {
      kind: "coding",
      version: "migration-fixture",
      effectiveAt: 1,
      evalCount: 1,
      curatedModels: [],
      provenance: "minted",
    });
    const modelId = await ctx.db.insert("models", {
      slug: "test/model",
      formattedName: "Test",
      provider: "test",
      apiKind: "chat",
      openRouterFirstSeenAt: 1,
      createdAt: 1,
      updatedAt: 1,
      lastSeenAt: 1,
    });
    const evidence = {
      storageId: await ctx.storage.store(new Blob(["{}"])),
      sha256: "a".repeat(64),
    };
    const legacyRun = await ctx.db.insert("runs", {
      kind: "coding",
      modelId,
      provider: "test",
      plannedEvals: ["cat/task"],
      benchmarkVersion,
      status: { kind: "completed", durationMs: 27 },
    });
    const taggedRun = await ctx.db.insert("runs", {
      kind: "coding",
      modelId,
      provider: "test",
      plannedEvals: ["cat/task"],
      benchmarkVersion,
      status: { kind: "running" },
    });
    const decisionRun = await ctx.db.insert("runs", {
      kind: "decision",
      benchmarkVersion,
      runKey: "migration-decision",
      model: "typesafe/jev-1.13",
      condition: "no_guidelines",
      profile: {
        reasoningEffort: null,
        maxOutputTokens: null,
        timeoutMs: 1000,
        maxRetries: 0,
        seed: "fixture",
        repetitions: 1,
      },
      profileHash: "b".repeat(64),
      plannedQuestions: ["cat/task/q"],
      fullSuite: true,
      origin: { kind: "development", sourceCommit: null },
      status: "running",
    });
    const legacyEval = await ctx.db.insert("evals", {
      kind: "coding",
      runId: legacyRun,
      evalPath: "cat/task",
      category: "cat",
      name: "task",
      status: { kind: "passed", durationMs: 27 },
    });
    const taggedEval = await ctx.db.insert("evals", {
      kind: "coding",
      runId: taggedRun,
      evalPath: "cat/task",
      category: "cat",
      name: "task",
      status: { kind: "pending" },
    });
    const decisionEval = await ctx.db.insert("evals", {
      kind: "decision",
      runId: decisionRun,
      questionKey: "cat/task/q",
      repetition: 0,
      outcome: "answered",
      selectedCanonicalId: "b",
      correct: true,
      returnedModel: "typesafe/jev-1.13",
      durationMs: 12,
      requestAttempts: 1,
      costUsd: null,
      knownCostUsd: 0,
      evidence,
    });
    const scoreFields = {
      modelId,
      benchmarkVersion,
      totalScore: 1,
      totalScoreErrorBar: 0,
      averageRunDurationMs: 27,
      averageRunDurationMsErrorBar: 0,
      averageRunCostUsd: null,
      averageRunCostUsdErrorBar: null,
      scores: { cat: 1 },
      scoreErrorBars: { cat: 0 },
      runCount: 1,
      latestRunId: legacyRun,
      latestRunTime: 1,
    };
    const legacyScore = await ctx.db.insert("modelScores", {
      ...scoreFields,
      kind: "coding",
    });
    const taggedScore = await ctx.db.insert("modelScores", {
      ...scoreFields,
      kind: "coding",
      experiment: "no_guidelines",
    });
    const decisionScore = await ctx.db.insert("modelScores", {
      kind: "decision",
      benchmarkVersion,
      model: "typesafe/jev-1.13",
      condition: "no_guidelines",
      profileHash: "b".repeat(64),
      score: 1,
      scoreStdDev: 0,
      categoryScores: { cat: 1 },
      runCount: 1,
      plannedQuestions: 1,
      invalidResponses: 0,
      providerErrors: 0,
      averageRunDurationMs: 12,
      medianQuestionDurationMs: 12,
      p95QuestionDurationMs: 12,
      averageKnownRunCostUsd: 0,
      completeCostRunCount: 0,
      averageRunCostUsd: null,
      latestRunId: decisionRun,
      latestRunTime: 1,
    });
    return {
      legacyRun,
      taggedRun,
      decisionRun,
      legacyEval,
      taggedEval,
      decisionEval,
      legacyScore,
      taggedScore,
      decisionScore,
    };
  });
  return { t, ids };
}

describe("shared document kind compatibility", () => {
  it("caps audit reads and reads a shared relationship once per page", async () => {
    expect(
      boundedAuditPagination({
        cursor: null,
        numItems: 100,
        maximumBytesRead: AUDIT_MAX_PAGE_BYTES * 4,
      }).maximumBytesRead,
    ).toBe(AUDIT_MAX_PAGE_BYTES);
    expect(
      boundedAuditPagination({ cursor: null, numItems: 100 }).maximumBytesRead,
    ).toBe(AUDIT_MAX_PAGE_BYTES);

    let reads = 0;
    const getParent = cachedAuditRead(async (id: string) => {
      reads += 1;
      await Promise.resolve();
      return { id };
    });
    const parents = await Promise.all(
      Array.from({ length: 100 }, () => getParent("shared-run")),
    );
    expect(parents).toHaveLength(100);
    expect(reads).toBe(1);
    await getParent("other-run");
    expect(reads).toBe(2);
  });

  it("audits every large eval through byte-bounded pages", async () => {
    const { t, ids } = await fixture();
    await t.run(async (ctx) => {
      for (let index = 0; index < 12; index++) {
        await ctx.db.insert("evals", {
          kind: "coding",
          runId: ids.legacyRun,
          evalPath: `cat/large-${index}`,
          category: "cat",
          name: `large-${index}`,
          status: { kind: "pending" },
          task: `${index}:${"x".repeat(80_000)}`,
        });
      }
    });
    let cursor: string | null = null;
    let pages = 0;
    let scanned = 0;
    let missingKind = 0;
    let coding = 0;
    let decision = 0;
    let codingByBenchmark = 0;
    while (true) {
      const audit: FunctionReturnType<
        typeof internal.migrations.auditDocumentKinds
      > = await t.query(internal.migrations.auditDocumentKinds, {
        table: "evals",
        paginationOpts: {
          cursor,
          numItems: 100,
          maximumBytesRead: 180_000,
        },
      });
      pages += 1;
      scanned += audit.scanned;
      missingKind += audit.missingKind;
      coding += audit.coding;
      decision += audit.decision;
      codingByBenchmark += Object.values(audit.codingByBenchmark).reduce(
        (total, count) => total + count,
        0,
      );
      expect(audit.relationshipErrors).toEqual([]);
      if (audit.isDone) break;
      cursor = audit.continueCursor;
    }
    expect(pages).toBeGreaterThan(1);
    expect(scanned).toBe(15);
    expect({ missingKind, coding, decision, codingByBenchmark }).toEqual({
      missingKind: 0,
      coding: 14,
      decision: 1,
      codingByBenchmark: 14,
    });
  });

  it("audits strict tags and relationships in resumable pages", async () => {
    const { t, ids } = await fixture();
    for (const table of ["runs", "evals", "modelScores"] as const) {
      let cursor: string | null = null;
      let scanned = 0;
      while (true) {
        const audit: FunctionReturnType<
          typeof internal.migrations.auditDocumentKinds
        > = await t.query(internal.migrations.auditDocumentKinds, {
          table,
          paginationOpts: { cursor, numItems: 1 },
        });
        scanned += audit.scanned;
        expect(audit.missingKind).toBe(0);
        expect(audit.relationshipErrors).toEqual([]);
        if (audit.isDone) break;
        cursor = audit.continueCursor;
      }
      expect(scanned).toBe(3);
    }
  });

  it("narrows strict coding records and rejects the opposite kind", async () => {
    const { t, ids } = await fixture();
    await t.run(async (ctx) => {
      const coding = await ctx.db.get("runs", ids.legacyRun);
      const decision = await ctx.db.get("runs", ids.decisionRun);
      if (!coding || !decision) throw new Error("Missing fixtures");
      expect(requireCodingRun(coding).kind).toBe("coding");
      expect(requireDecisionRun(decision)).toEqual(decision);
      expect(() => requireCodingRun(decision)).toThrow("coding run");
      expect(() => requireDecisionRun(coding)).toThrow("decision run");
    });
  });

  it("reports cross-kind parent corruption and rejects unbounded audit pages", async () => {
    const { t, ids } = await fixture();
    await t.run(async (ctx) => {
      await ctx.db.patch("evals", ids.decisionEval, { runId: ids.legacyRun });
      await ctx.db.patch("modelScores", ids.decisionScore, {
        latestRunId: ids.legacyRun,
      });
    });
    for (const table of ["evals", "modelScores"] as const) {
      const audit = await t.query(internal.migrations.auditDocumentKinds, {
        table,
        paginationOpts: { cursor: null, numItems: 100 },
      });
      expect(audit.relationshipErrors).toHaveLength(1);
      expect(audit.relationshipErrors[0].reason).toContain("opposite-kind");
    }
    await expect(
      t.query(internal.migrations.auditDocumentKinds, {
        table: "runs",
        paginationOpts: { cursor: null, numItems: 101 },
      }),
    ).rejects.toThrow("1 to 100");
  });
});
