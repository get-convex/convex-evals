import { convexTest } from "convex-test";
import { describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import schema from "./schema.js";
import { modules } from "./test.setup.js";
import { requireDecisionRun } from "./documentKinds.js";

describe("decision cost estimate lifecycle", () => {
  it("finalizes estimates and idempotently backfills legacy runs without changing billing or scores", async () => {
    vi.useFakeTimers();
    try {
      const t = convexTest(schema, modules);
      const storageId = await t.run((ctx) =>
        ctx.storage.store(new Blob(["evidence"])),
      );
      const evidence = { storageId, sha256: "a".repeat(64) };
      await t.mutation(internal.benchmarkVersions.mint, {
        version: "coding-cost-test",
        evalCount: 1,
        curatedModels: [],
      });
      await t.mutation(internal.benchmarkVersions.mint, {
        version: "decision-cost-test",
        evalCount: 1,
        curatedModels: [],
        codingBenchmarkVersionHash: "coding-cost-test",
        decision: {
          protocolVersion: 1,
          sourceCommit: "a".repeat(40),
          sourceEvidence: evidence,
          sources: [
            {
              evalPath: "cat/task",
              questions: ["q1", "q2"].map((id) => ({
                id,
                optionIds: ["a", "b", "c", "d"],
                correctOptionId: "a",
              })),
            },
          ],
        },
      });
      const { runId } = await t.mutation(
        internal.decisionStorage.createDecisionRun,
        {
          runKey: "cost-test",
          benchmarkHash: "decision-cost-test",
          model: "test/model",
          condition: "no_guidelines",
          profileHash: "b".repeat(64),
          profile: {
            reasoningEffort: "low",
            maxOutputTokens: 2048,
            timeoutMs: 45000,
            maxRetries: 1,
            seed: "seed",
            repetitions: 1,
          },
          plannedQuestions: ["cat/task/q1", "cat/task/q2"],
          origin: { kind: "development", sourceCommit: null },
        },
      );
      const items = [
        {
          questionKey: "cat/task/q1",
          repetition: 0,
          outcome: "answered" as const,
          selectedCanonicalId: "a",
          correct: true,
          returnedModel: "test/model",
          durationMs: 10,
          requestAttempts: 1,
          costUsd: 1,
          knownCostUsd: 1,
          evidence,
        },
        {
          questionKey: "cat/task/q2",
          repetition: 0,
          outcome: "provider_error" as const,
          selectedCanonicalId: null,
          correct: false,
          returnedModel: null,
          durationMs: 45000,
          requestAttempts: 1,
          costUsd: null,
          knownCostUsd: 0,
          evidence,
        },
      ];
      await t.mutation(internal.decisionStorage.recordDecisionResults, {
        runId,
        items,
      });
      const finalized = await t.mutation(
        internal.decisionStorage.finalizeDecisionRun,
        {
          runId,
          evidence,
          finishedAt: 50000,
          durationMs: 45010,
          resultEvidence: items.map(({ questionKey, repetition }) => ({
            questionKey,
            repetition,
            ...evidence,
          })),
          failureReason: null,
          orphanAttempts: 0,
          orphanKnownCostUsd: 0,
          hasUnknownOrphanCost: false,
        },
      );
      expect(finalized.summary).toMatchObject({
        score: 0.5,
        costUsd: null,
        knownCostUsd: 1,
        estimatedCostUsd: 2,
      });
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      // Model an already-completed production run written before this field existed.
      const before = await t.run(async (ctx) => {
        const run = requireDecisionRun((await ctx.db.get("runs", runId))!);
        const summary = { ...run.summary! };
        delete summary.estimatedCostUsd;
        await ctx.db.patch("runs", runId, { summary });
        return summary;
      });
      expect(
        await t.mutation(
          internal.decisionStorage.backfillDecisionCostEstimates,
          { runIds: [runId, runId] },
        ),
      ).toEqual({ updatedRuns: 1 });
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      expect(
        await t.mutation(
          internal.decisionStorage.backfillDecisionCostEstimates,
          { runIds: [runId] },
        ),
      ).toEqual({ updatedRuns: 0 });
      const publicRun = await t.query(api.runs.getDecisionRun, { runId });
      expect(publicRun?.summary).toEqual({ ...before, estimatedCostUsd: 2 });
      const leaderboard = await t.query(api.runs.decisionLeaderboard, {
        benchmarkVersion: "decision-cost-test",
        condition: "no_guidelines",
        paginationOpts: { cursor: null, numItems: 10 },
      });
      expect(leaderboard.results.page[0]).toMatchObject({
        score: 0.5,
        runCount: 1,
        averageRunCostUsd: null,
        averageKnownRunCostUsd: 1,
        estimatedAverageRunCostUsd: 2,
      });
      const results = await t.query(api.evals.decisionResults, {
        runId,
        paginationOpts: { cursor: null, numItems: 10 },
      });
      expect(results.page.map(({ costUsd }) => costUsd)).toEqual([1, null]);
      await expect(
        t.mutation(internal.decisionStorage.backfillDecisionCostEstimates, {
          runIds: Array(6).fill(runId),
        }),
      ).rejects.toThrow("at most five");
    } finally {
      vi.useRealTimers();
    }
  });
});
