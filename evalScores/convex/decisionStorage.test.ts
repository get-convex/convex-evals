import { convexTest } from "convex-test";
import { describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import schema from "./schema.js";
import { modules } from "./test.setup.js";
import { assertDecisionIngestionEnabled } from "./decisionConfig.js";

describe("decision shared-table lifecycle", () => {
  it("enables reporting after the strict rollout and still enforces a disabled gate", () => {
    expect(() => assertDecisionIngestionEnabled()).not.toThrow();
    expect(() => assertDecisionIngestionEnabled(false)).toThrow(
      "strict kind migration",
    );
  });

  it("records immutable results, finalizes the exact plan, and materializes its cohort", async () => {
    vi.useFakeTimers();
    try {
      const t = convexTest(schema, modules);
      const evidence = await t.run(async (ctx) => ({
        source: await ctx.storage.store(new Blob(["source"])),
        question: await ctx.storage.store(new Blob(["question"])),
        duplicate: await ctx.storage.store(new Blob(["duplicate"])),
        final: await ctx.storage.store(new Blob(["final"])),
      }));
      const decisionDefinition = {
        protocolVersion: 1,
        sourceCommit: "a".repeat(40),
        sourceEvidence: { storageId: evidence.source, sha256: "1".repeat(64) },
        sources: [
          {
            evalPath: "cat/task",
            questions: [
              {
                id: "q",
                optionIds: ["a", "b", "c", "d"],
                correctOptionId: "b",
              },
            ],
          },
        ],
      };
      await t.mutation(internal.benchmarkVersions.mint, {
        version: "shared-v1",
        evalCount: 112,
        curatedModels: [],
        decision: decisionDefinition,
      });
      await t.mutation(internal.benchmarkVersions.mint, {
        version: "shared-v1",
        evalCount: 112,
        curatedModels: [],
        decision: {
          ...decisionDefinition,
          sourceEvidence: {
            storageId: evidence.duplicate,
            sha256: "1".repeat(64),
          },
        },
      });
      const preserved = await t.run((ctx) =>
        ctx.db
          .query("benchmarkVersions")
          .withIndex("by_version", (q) => q.eq("version", "shared-v1"))
          .unique(),
      );
      expect(preserved?.decision?.sourceEvidence.storageId).toBe(
        evidence.source,
      );
      await expect(
        t.mutation(internal.benchmarkVersions.mint, {
          version: "shared-v1",
          evalCount: 112,
          curatedModels: ["changed"],
        }),
      ).rejects.toThrow("immutable shared metadata");
      const args = {
        runKey: "development:test-run",
        benchmarkHash: "shared-v1",
        model: "test/model",
        condition: "no_guidelines" as const,
        profile: {
          reasoningEffort: "low" as const,
          maxOutputTokens: 10,
          timeoutMs: 1_000,
          maxRetries: 0,
          seed: "seed",
          repetitions: 1,
        },
        profileHash: "2".repeat(64),
        plannedQuestions: ["cat/task/q"],
        origin: { kind: "development" as const, sourceCommit: null },
      };
      const started = await t.mutation(
        internal.decisionStorage.createDecisionRun,
        args,
      );
      expect(
        await t.mutation(internal.decisionStorage.createDecisionRun, args),
      ).toEqual(started);
      await expect(
        t.mutation(internal.decisionStorage.createDecisionRun, {
          ...args,
          model: "other/model",
        }),
      ).rejects.toThrow("reused with different inputs");

      const stored = {
        questionKey: "cat/task/q",
        repetition: 0,
        outcome: "answered" as const,
        selectedCanonicalId: "b",
        correct: true,
        returnedModel: "test/model",
        durationMs: 25,
        requestAttempts: 1,
        costUsd: 0,
        knownCostUsd: 0,
        evidence: { storageId: evidence.question, sha256: "3".repeat(64) },
      };
      await expect(
        t.mutation(internal.decisionStorage.recordDecisionResults, {
          runId: started.runId,
          items: [{ ...stored, questionKey: "cat/task/not-planned" }],
        }),
      ).rejects.toThrow("outside the immutable decision plan");
      expect(
        await t.mutation(internal.decisionStorage.recordDecisionResults, {
          runId: started.runId,
          items: [stored],
        }),
      ).toEqual({ inserted: 1, unchanged: 0 });
      expect(
        await t.mutation(internal.decisionStorage.recordDecisionResults, {
          runId: started.runId,
          items: [
            {
              ...stored,
              evidence: {
                storageId: evidence.duplicate,
                sha256: "3".repeat(64),
              },
            },
          ],
        }),
      ).toEqual({ inserted: 0, unchanged: 1 });

      const parent = await t.query(internal.decisionStorage.getDecisionParent, {
        runId: started.runId,
      });
      expect(parent._id).toBe(started.runId);
      const sourceContext = await t.query(
        internal.decisionStorage.getDecisionSourceContext,
        { runId: started.runId },
      );
      expect(sourceContext.run._id).toBe(started.runId);
      expect(sourceContext).not.toHaveProperty("results");
      const finalizationContext = await t.query(
        internal.decisionStorage.getDecisionFinalizationContext,
        { runId: started.runId },
      );
      expect(finalizationContext.results).toHaveLength(1);

      const finalized = await t.mutation(
        internal.decisionStorage.finalizeDecisionRun,
        {
          runId: started.runId,
          evidence: { storageId: evidence.final, sha256: "4".repeat(64) },
          resultEvidence: [
            {
              questionKey: "cat/task/q",
              repetition: 0,
              storageId: evidence.question,
              sha256: "3".repeat(64),
            },
          ],
          finishedAt: 10,
          durationMs: 25,
          failureReason: null,
          orphanAttempts: 0,
          orphanKnownCostUsd: 0,
          hasUnknownOrphanCost: false,
        },
      );
      expect(finalized.status).toBe("completed");
      expect(finalized.summary.score).toBe(1);
      vi.runAllTimers();
      await t.finishInProgressScheduledFunctions();

      const leaderboard = await t.query(api.decisionViews.decisionLeaderboard, {
        benchmarkVersion: "shared-v1",
        condition: "no_guidelines",
        paginationOpts: { cursor: null, numItems: 10 },
      });
      expect(leaderboard.availability).toBe("ready");
      expect(leaderboard.results.page).toHaveLength(1);
      expect(leaderboard.results.page[0]).toMatchObject({
        kind: "decision",
        score: 1,
        validResponses: 1,
        decisionQuestionCount: 1,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not fall back to an older decision version when the shared current version is coding-only", async () => {
    const t = convexTest(schema, modules);
    const source = await t.run((ctx) =>
      ctx.storage.store(new Blob(["source"])),
    );
    await t.mutation(internal.benchmarkVersions.mint, {
      version: "older",
      evalCount: 112,
      curatedModels: [],
      decision: {
        protocolVersion: 1,
        sourceCommit: "a".repeat(40),
        sourceEvidence: { storageId: source, sha256: "1".repeat(64) },
        sources: [
          {
            evalPath: "cat/task",
            questions: [
              {
                id: "q",
                optionIds: ["a", "b", "c", "d"],
                correctOptionId: "a",
              },
            ],
          },
        ],
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 2));
    await t.mutation(internal.benchmarkVersions.mint, {
      version: "newer-coding-only",
      evalCount: 112,
      curatedModels: [],
    });
    const current = await t.query(api.decisionViews.decisionLeaderboard, {
      condition: "no_guidelines",
      paginationOpts: { cursor: null, numItems: 10 },
    });
    expect(current.availability).toBe("not_available");
    expect(current.benchmark?.version).toBe("newer-coding-only");
    expect(current.benchmark?.decisionAvailable).toBe(false);
  });
});
