import { convexTest } from "convex-test";
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import type { DataModel } from "./_generated/dataModel.js";
import type { QueryCtx, MutationCtx } from "./_generated/server.js";
import { leaderboardModelHistory, leaderboardVersions } from "./runs.js";
import { recomputeModelScores } from "./modelScores.js";
import schema from "./schema.js";
import { modules } from "./test.setup.js";

// Count documents returned by the real convex-test query implementation. This
// verifies early stopping without claiming these are production billing metrics.
function trackReads(db: QueryCtx["db"]): {
  db: QueryCtx["db"];
  counts: Record<string, number>;
  queries: Record<string, number>;
} {
  const counts: Record<string, number> = {};
  const queries: Record<string, number> = {};
  const count = (table: string, value: unknown): unknown => {
    counts[table] =
      (counts[table] ?? 0) +
      (Array.isArray(value) ? value.length : value ? 1 : 0);
    return value;
  };
  const wrap = (query: object, table: string): object =>
    new Proxy(query, {
      get(target, key) {
        if (key === Symbol.asyncIterator)
          return async function* () {
            for await (const row of target as AsyncIterable<unknown>) {
              count(table, row);
              yield row;
            }
          };
        const value: unknown = Reflect.get(target, key);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          const result: unknown = Reflect.apply(value, target, args);
          if (["collect", "take", "first", "unique"].includes(String(key))) {
            return (result as Promise<unknown>).then((rows) =>
              count(table, rows),
            );
          }
          return wrap(result as object, table);
        };
      },
    });
  const instrumented = new Proxy(db, {
    get(target, key) {
      if (key === "query")
        return (table: string) => {
          queries[table] = (queries[table] ?? 0) + 1;
          return wrap(target.query(table as keyof DataModel), table);
        };
      const value: unknown = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db: instrumented, counts, queries };
}

const historyHandler = (
  leaderboardModelHistory as unknown as {
    _handler: (
      ctx: QueryCtx,
      args: FunctionArgs<typeof api.runs.leaderboardModelHistory>,
    ) => Promise<FunctionReturnType<typeof api.runs.leaderboardModelHistory>>;
  }
)._handler;
const versionsHandler = (
  leaderboardVersions as unknown as {
    _handler: (
      ctx: QueryCtx,
      args: FunctionArgs<typeof api.runs.leaderboardVersions>,
    ) => Promise<FunctionReturnType<typeof api.runs.leaderboardVersions>>;
  }
)._handler;
const recomputeHandler = (
  recomputeModelScores as unknown as {
    _handler: (
      ctx: MutationCtx,
      args: FunctionArgs<typeof internal.modelScores.recomputeModelScores>,
    ) => Promise<null>;
  }
)._handler;

afterEach(() => vi.useRealTimers());

async function historyFixture() {
  vi.useFakeTimers();
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const benchmarkVersion = await ctx.db.insert("benchmarkVersions", {
      version: "performance-fixture",
      effectiveAt: 1,
      evalCount: 1,
      curatedModels: ["test/history"],
      provenance: "minted",
    });
    const modelId = await ctx.db.insert("models", {
      slug: "test/history",
      formattedName: "History",
      provider: "test",
      apiKind: "chat",
      openRouterFirstSeenAt: 1,
      createdAt: 1,
      updatedAt: 1,
      lastSeenAt: 1,
    });
    const validRuns = [];
    for (let index = 0; index < 200; index++) {
      vi.setSystemTime(1_000_000 + index * 1000);
      const runId = await ctx.db.insert("runs", {
        kind: "coding",
        benchmarkVersion,
        modelId,
        provider: "test",
        plannedEvals: ["cat/task"],
        status: { kind: "completed", durationMs: 10 },
      });
      await ctx.db.insert("evals", {
        kind: "coding",
        runId,
        evalPath: "cat/task",
        category: "cat",
        name: "task",
        status: { kind: "passed", durationMs: 10 },
      });
      validRuns.push(runId);
    }
    // Recent filtered plans and completed runs with missing evals must not
    // crowd out older complete runs when we stop after the requested count.
    for (let index = 0; index < 14; index++) {
      vi.setSystemTime(2_000_000 + index * 1000);
      await ctx.db.insert("runs", {
        kind: "coding",
        benchmarkVersion,
        modelId,
        provider: "test",
        plannedEvals: index < 7 ? [] : ["cat/task"],
        status: { kind: "completed", durationMs: 10 },
      });
    }
    return { benchmarkVersion, modelId, validRuns };
  });
  return { t, ...ids };
}

describe("coding leaderboard read bounds", () => {
  for (const benchmarkVersion of ["performance-fixture", "all"]) {
    it(`stops history reads after enough valid runs (${benchmarkVersion})`, async () => {
      const { t, modelId, validRuns } = await historyFixture();
      await t.run(async (ctx) => {
        const tracked = trackReads(ctx.db);
        const rows = await historyHandler(
          { ...ctx, db: tracked.db },
          { modelId, benchmarkVersion, limit: 10 },
        );
        expect(rows.map((row) => row.runId)).toEqual(validRuns.slice(-10));
        expect(rows.every((row) => row.totalScore === 1)).toBe(true);
        expect(tracked.counts.runs).toBe(24);
        expect(tracked.counts.evals).toBe(10);
        expect(tracked.queries.evals).toBe(17);
      });
    });
  }

  it("stops score recomputation after ten valid runs", async () => {
    const { t, modelId, benchmarkVersion, validRuns } = await historyFixture();
    await t.run(async (ctx) => {
      const tracked = trackReads(ctx.db);
      await recomputeHandler(
        { ...ctx, db: tracked.db as MutationCtx["db"] },
        { modelId, benchmarkVersion },
      );
      expect(tracked.counts.runs).toBe(24);
      expect(tracked.counts.evals).toBe(10);
      const score = await ctx.db.query("modelScores").first();
      expect(score).toMatchObject({
        kind: "coding",
        runCount: 10,
        totalScore: 1,
        latestRunId: validRuns.at(-1),
      });
    });
  });

  it("reuses the version scan and does not enumerate unrelated model metadata", async () => {
    const { t } = await historyFixture();
    await t.run(async (ctx) => {
      const tracked = trackReads(ctx.db);
      const versions = await versionsHandler({ ...ctx, db: tracked.db }, {});
      expect(versions[0]).toMatchObject({
        version: "performance-fixture",
        isCurrent: true,
      });
      // Tagged and legacy partitions are read once each during compatibility.
      expect(tracked.queries.benchmarkVersions).toBe(2);
      expect(tracked.queries.models ?? 0).toBe(0);
    });
  });
});
