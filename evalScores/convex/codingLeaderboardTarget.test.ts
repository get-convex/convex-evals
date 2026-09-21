import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import schema from "./schema.js";
import { modules } from "./test.setup.js";

const scoreFields = {
  totalScore: 0.75,
  totalScoreErrorBar: 0,
  averageRunDurationMs: 100,
  averageRunDurationMsErrorBar: 0,
  averageRunCostUsd: null,
  averageRunCostUsdErrorBar: null,
  scores: { cat: 0.75 },
  scoreErrorBars: { cat: 0 },
  runCount: 1,
};

describe("targeted coding leaderboard reads", () => {
  it("reads one exact model partition without scanning unrelated scores", async () => {
    // Slug lookup + benchmark lookup + exact model score index range. Model
    // metadata is reused from the slug lookup instead of being read again.
    const t = convexTest({
      schema,
      modules,
      transactionLimits: { databaseQueries: 4, documentsRead: 10 },
    });
    await t.run(async (ctx) => {
      const benchmarkVersion = await ctx.db.insert("benchmarkVersions", {
        version: "target-benchmark",
        effectiveAt: 1,
        evalCount: 1,
        curatedModels: [],
        provenance: "minted",
      });
      const insertScore = async (
        slug: string,
        index: number,
      ): Promise<void> => {
        const modelId = await ctx.db.insert("models", {
          slug,
          formattedName: `Model ${index}`,
          provider: "fixture",
          apiKind: "chat" as const,
          openRouterFirstSeenAt: 0,
          createdAt: 0,
          updatedAt: 0,
          lastSeenAt: 0,
        });
        const latestRunId = await ctx.db.insert("runs", {
          kind: "coding" as const,
          modelId,
          provider: "fixture",
          plannedEvals: ["cat/eval"],
          benchmarkVersion,
          status: { kind: "completed" as const, durationMs: 100 },
        });
        await ctx.db.insert("modelScores", {
          kind: "coding" as const,
          modelId,
          benchmarkVersion,
          ...scoreFields,
          latestRunId,
          latestRunTime: index,
        });
      };
      await insertScore("target/model", 0);
      for (let index = 1; index <= 500; index += 1) {
        await insertScore(`unrelated/model-${index}`, index);
      }
    });

    const rows = await t.query(api.runs.leaderboardScores, {
      model: "target/model",
      benchmarkVersion: "target-benchmark",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      model: "target/model",
      formattedName: "Model 0",
      benchmarkVersion: "target-benchmark",
      scoreBenchmarkVersion: "target-benchmark",
      matchesSelectedBenchmark: true,
    });
  });

  it("keeps historical fallback and all-version aggregation scoped to the target", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const oldBenchmark = await ctx.db.insert("benchmarkVersions", {
        version: "old-benchmark",
        effectiveAt: Date.now() - 1_000,
        evalCount: 1,
        curatedModels: [],
        provenance: "minted",
      });
      const currentBenchmark = await ctx.db.insert("benchmarkVersions", {
        version: "current-benchmark",
        effectiveAt: Date.now(),
        evalCount: 2,
        curatedModels: [],
        provenance: "minted",
      });
      const insertModel = async (
        slug: string,
        name: string,
      ): Promise<Id<"models">> => {
        return await ctx.db.insert("models", {
          slug,
          formattedName: name,
          provider: "fixture",
          apiKind: "chat" as const,
          openRouterFirstSeenAt: 0,
          createdAt: 0,
          updatedAt: 0,
          lastSeenAt: 0,
        });
      };
      const targetModelId = await insertModel("target/model", "Target");
      const unrelatedModelId = await insertModel("other/model", "Other");
      const insertScore = async (
        modelId: Id<"models">,
        benchmarkVersion: Id<"benchmarkVersions">,
        totalScore: number,
      ): Promise<void> => {
        const latestRunId = await ctx.db.insert("runs", {
          kind: "coding" as const,
          modelId,
          provider: "fixture",
          plannedEvals: ["cat/eval"],
          benchmarkVersion,
          status: { kind: "completed" as const, durationMs: 100 },
        });
        await ctx.db.insert("modelScores", {
          kind: "coding" as const,
          modelId,
          benchmarkVersion,
          ...scoreFields,
          totalScore,
          scores: { cat: totalScore },
          latestRunId,
          latestRunTime: Date.now(),
        });
      };
      await insertScore(targetModelId, oldBenchmark, 0.6);
      await insertScore(unrelatedModelId, oldBenchmark, 0.4);
      await insertScore(unrelatedModelId, currentBenchmark, 0.9);
    });

    const fallback = await t.query(api.runs.leaderboardScores, {
      model: "target/model",
      benchmarkVersion: "current-benchmark",
      includeRecentPreviousBenchmarks: true,
      limit: 100,
    });
    expect(fallback).toHaveLength(1);
    expect(fallback[0]).toMatchObject({
      model: "target/model",
      benchmarkVersion: "current-benchmark",
      scoreBenchmarkVersion: "old-benchmark",
      matchesSelectedBenchmark: false,
      totalScore: 0.6,
    });

    const all = await t.query(api.runs.leaderboardScores, {
      model: "target/model",
      benchmarkVersion: "all",
    });
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      model: "target/model",
      benchmarkVersion: "all",
      scoreBenchmarkVersion: "all",
      matchesSelectedBenchmark: true,
      totalScore: 0.6,
    });
  });
});
