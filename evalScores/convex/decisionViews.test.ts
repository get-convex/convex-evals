import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import schema from "./schema.js";
import { modules } from "./test.setup.js";

const profile = {
  reasoningEffort: "low" as const,
  maxOutputTokens: 128,
  timeoutMs: 30_000,
  maxRetries: 1,
  seed: "view-test-seed",
  repetitions: 1,
};

describe("decision leaderboard read paths", () => {
  it("uses the model cohort prefix and keeps page joins constant with large unrelated history", async () => {
    // Compatibility needs two indexed benchmark lookups, one paginated read and
    // one deduplicated model metadata lookup, independent of the page length.
    const t = convexTest({
      schema,
      modules,
      transactionLimits: { databaseQueries: 4, documentsRead: 200 },
    });
    await t.run(async (ctx) => {
      const source = await ctx.storage.store(new Blob(["source"]));
      const benchmarkVersion = await ctx.db.insert("benchmarkVersions", {
        version: "decision-view-v1",
        effectiveAt: 1,
        evalCount: 1,
        curatedModels: [],
        provenance: "minted",
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
      await ctx.db.insert("models", {
        slug: "target/model",
        formattedName: "Target Model",
        provider: "fixture",
        apiKind: "chat",
        openRouterFirstSeenAt: 0,
        createdAt: 0,
        updatedAt: 0,
        lastSeenAt: 0,
      });
      const insertRun = (runKey: string, model: string): Promise<Id<"runs">> =>
        ctx.db.insert("runs", {
          kind: "decision" as const,
          benchmarkVersion,
          runKey,
          model,
          condition: "no_guidelines" as const,
          profile,
          profileHash: "2".repeat(64),
          plannedQuestions: ["cat/task/q"],
          fullSuite: true,
          origin: { kind: "development" as const, sourceCommit: null },
          status: "completed" as const,
        });
      for (let index = 0; index < 130; index += 1) {
        await insertRun(`target-${index}`, "target/model");
      }
      // These newer rows share the benchmark and condition but not the model.
      // A condition scan plus filter would walk them; the cohort index prefix
      // selects only target/model before pagination.
      for (let index = 0; index < 500; index += 1) {
        await insertRun(`unrelated-${index}`, `unrelated/model-${index}`);
      }
    });

    const first = await t.query(api.decisionViews.listDecisionRuns, {
      benchmarkVersion: "decision-view-v1",
      condition: "no_guidelines",
      model: "target/model",
      paginationOpts: { cursor: null, numItems: 10_000 },
    });
    expect(first.page).toHaveLength(100);
    expect(first.isDone).toBe(false);
    expect(new Set(first.page.map((run) => run.model))).toEqual(
      new Set(["target/model"]),
    );
    expect(new Set(first.page.map((run) => run.formattedName))).toEqual(
      new Set(["Target Model"]),
    );

    const second = await t.query(api.decisionViews.listDecisionRuns, {
      benchmarkVersion: "decision-view-v1",
      condition: "no_guidelines",
      model: "target/model",
      paginationOpts: { cursor: first.continueCursor, numItems: 10_000 },
    });
    expect(second.page).toHaveLength(30);
    expect(second.isDone).toBe(true);
    expect(
      new Set([
        ...first.page.map((run) => run._id),
        ...second.page.map((run) => run._id),
      ]).size,
    ).toBe(130);
  });

  it("finds the latest public benchmark beyond an arbitrary unminted prefix", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const source = await ctx.storage.store(new Blob(["source"]));
      await ctx.db.insert("benchmarkVersions", {
        version: "latest-public",
        effectiveAt: 1,
        evalCount: 1,
        curatedModels: [],
        provenance: "minted",
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
      for (let index = 0; index < 1_001; index += 1) {
        await ctx.db.insert("benchmarkVersions", {
          kind: "coding",
          version: `unminted-${index}`,
          effectiveAt: index + 2,
          evalCount: 1,
          curatedModels: [],
          provenance: "unminted",
        });
      }
    });

    const result = await t.query(api.decisionViews.decisionLeaderboard, {
      condition: "no_guidelines",
      paginationOpts: { cursor: null, numItems: 10 },
    });
    expect(result.availability).toBe("ready");
    expect(result.benchmark?.version).toBe("latest-public");
    expect(result.results.page).toEqual([]);
  });

  it("deduplicates model metadata while preserving each materialized profile", async () => {
    // Two compatibility benchmark queries + one score page + ten latest-run reads + one model
    // lookup. Looking up the same model once per profile would exceed this.
    const t = convexTest({
      schema,
      modules,
      transactionLimits: { databaseQueries: 14, documentsRead: 30 },
    });
    await t.run(async (ctx) => {
      const source = await ctx.storage.store(new Blob(["source"]));
      const benchmarkVersion = await ctx.db.insert("benchmarkVersions", {
        version: "decision-scores-v1",
        effectiveAt: 1,
        evalCount: 1,
        curatedModels: [],
        provenance: "minted",
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
      await ctx.db.insert("models", {
        slug: "shared/model",
        formattedName: "Shared Model",
        provider: "fixture",
        apiKind: "chat",
        openRouterFirstSeenAt: 0,
        createdAt: 0,
        updatedAt: 0,
        lastSeenAt: 0,
      });
      for (let index = 0; index < 10; index += 1) {
        const profileHash = `${index}`.padStart(64, "0");
        const latestRunId = await ctx.db.insert("runs", {
          kind: "decision",
          benchmarkVersion,
          runKey: `score-run-${index}`,
          model: "shared/model",
          condition: "no_guidelines",
          profile: { ...profile, seed: `seed-${index}` },
          profileHash,
          plannedQuestions: ["cat/task/q"],
          fullSuite: true,
          origin: { kind: "development", sourceCommit: null },
          status: "completed",
        });
        await ctx.db.insert("modelScores", {
          kind: "decision",
          benchmarkVersion,
          model: "shared/model",
          condition: "no_guidelines",
          profileHash,
          score: 1 - index / 100,
          scoreStdDev: 0,
          categoryScores: { cat: 1 - index / 100 },
          runCount: 1,
          plannedQuestions: 1,
          invalidResponses: 0,
          providerErrors: 0,
          averageRunDurationMs: 10,
          medianQuestionDurationMs: 10,
          p95QuestionDurationMs: 10,
          averageKnownRunCostUsd: index / 100,
          completeCostRunCount: index === 0 ? 0 : 1,
          averageRunCostUsd: index === 0 ? null : index / 100,
          latestRunId,
          latestRunTime: index,
        });
      }
    });

    const result = await t.query(api.decisionViews.decisionLeaderboard, {
      benchmarkVersion: "decision-scores-v1",
      condition: "no_guidelines",
      paginationOpts: { cursor: null, numItems: 100 },
    });
    expect(result.results.page).toHaveLength(10);
    expect(
      new Set(result.results.page.map((row) => row.profileHash)).size,
    ).toBe(10);
    expect(
      new Set(result.results.page.map((row) => row.formattedName)),
    ).toEqual(new Set(["Shared Model"]));
    expect(
      result.results.page.find((row) => row.averageRunCostUsd === null),
    ).toMatchObject({ averageKnownRunCostUsd: 0, completeCostRunCount: 0 });
  });
});
