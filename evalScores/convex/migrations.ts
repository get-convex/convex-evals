import { Migrations } from "@convex-dev/migrations";
import { components, internal } from "./_generated/api.js";
import { internalQuery } from "./_generated/server";
import type { DataModel, Id } from "./_generated/dataModel.js";
import { historicalBenchmarkForRun } from "./historicalBenchmarks";
import { paginationOptsValidator, type PaginationOptions } from "convex/server";
import { v } from "convex/values";
import { assertNever, isCodingEval, isCodingRun } from "./documentKinds.js";

export const migrations = new Migrations<DataModel>(components.migrations);

/**
 * Historical eval rows recorded scorer duration but not model generation
 * duration. startEval creates the eval document immediately before model
 * generation, and the first scoring step is recorded immediately after
 * generation, so this backfills a generation latency estimate.
 */
export const backfillEvalGenerationDurations = migrations.define({
  table: "evals",
  batchSize: 25,
  migrateOne: async (ctx, evalDoc) => {
    if (!isCodingEval(evalDoc)) return;
    const status = evalDoc.status;
    if (status.kind !== "passed" && status.kind !== "failed") return;
    if (status.generationDurationMs !== undefined) return;

    const steps = await ctx.db
      .query("steps")
      .withIndex("by_evalId", (q) => q.eq("evalId", evalDoc._id))
      .collect();
    const firstStep = steps.sort(
      (a, b) => a._creationTime - b._creationTime,
    )[0];
    if (!firstStep) return;

    const generationDurationMs =
      firstStep._creationTime - evalDoc._creationTime;
    if (!Number.isFinite(generationDurationMs) || generationDurationMs <= 0) {
      return;
    }

    return {
      status: {
        ...status,
        generationDurationMs,
      },
    };
  },
});

export const runEvalGenerationDurationBackfill = migrations.runner(
  internal.migrations.backfillEvalGenerationDurations,
);

/**
 * Replace missing or old string benchmark references with real IDs. Run
 * benchmarkVersions:seedHistorical first so every reconstructed cohort and
 * the unminted sentinel exist before this migration starts.
 */
export const backfillRunBenchmarkVersionIds = migrations.define({
  table: "runs",
  batchSize: 25,
  migrateOne: async (ctx, runDoc) => {
    if (!isCodingRun(runDoc)) return;
    if (runDoc.benchmarkVersion !== undefined) {
      const existingId = ctx.db.normalizeId(
        "benchmarkVersions",
        String(runDoc.benchmarkVersion),
      );
      if (existingId && (await ctx.db.get(existingId))) return;

      const byVersion = await ctx.db
        .query("benchmarkVersions")
        .withIndex("by_version", (q) =>
          q.eq("version", String(runDoc.benchmarkVersion)),
        )
        .unique();
      if (byVersion) return { benchmarkVersion: byVersion._id };
    }

    const definition = await historicalBenchmarkForRun(
      runDoc.plannedEvals,
      runDoc._creationTime,
    );
    const reconstructed = await ctx.db
      .query("benchmarkVersions")
      .withIndex("by_version", (q) => q.eq("version", definition.version))
      .unique();
    if (!reconstructed) {
      throw new Error(
        `Missing seeded benchmark version ${definition.version}. Run benchmarkVersions:seedHistorical first.`,
      );
    }
    return { benchmarkVersion: reconstructed._id };
  },
});

export const runBenchmarkVersionBackfill = migrations.runner(
  internal.migrations.backfillRunBenchmarkVersionIds,
);

export const auditBenchmarkVersionBackfill = internalQuery({
  args: {},
  handler: async (ctx) => {
    const runs = (
      await ctx.db
        .query("runs")
        .withIndex("by_kind", (q) => q.eq("kind", "coding"))
        .collect()
    ).filter(isCodingRun);
    const counts = new Map<Id<"benchmarkVersions">, number>();
    let unresolved = 0;

    for (const run of runs) {
      if (run.benchmarkVersion === undefined) {
        unresolved += 1;
        continue;
      }
      const id = ctx.db.normalizeId(
        "benchmarkVersions",
        String(run.benchmarkVersion),
      );
      if (!id || !(await ctx.db.get(id))) {
        unresolved += 1;
        continue;
      }
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }

    const versions = await ctx.db.query("benchmarkVersions").collect();
    return {
      totalRuns: runs.length,
      unresolved,
      versions: versions
        .map((version) => ({
          version: version.version,
          provenance: version.provenance,
          evalCount: version.evalCount,
          runCount: counts.get(version._id) ?? 0,
        }))
        .sort((a, b) => a.evalCount - b.evalCount),
    };
  },
});

export const run = migrations.runner();

export const runAll = migrations.runner([
  internal.migrations.backfillRunBenchmarkVersionIds,
  internal.migrations.backfillEvalGenerationDurations,
]);

export const AUDIT_MAX_PAGE_BYTES = 2 * 1024 * 1024;

export function boundedAuditPagination(
  options: PaginationOptions,
): PaginationOptions {
  if (
    !Number.isSafeInteger(options.numItems) ||
    options.numItems < 1 ||
    options.numItems > 100
  ) {
    throw new Error("Audit page size must be an integer from 1 to 100");
  }
  if (
    options.maximumBytesRead !== undefined &&
    (!Number.isSafeInteger(options.maximumBytesRead) ||
      options.maximumBytesRead < 1)
  ) {
    throw new Error("Audit byte limit must be a positive integer");
  }
  return {
    ...options,
    maximumBytesRead: Math.min(
      options.maximumBytesRead ?? AUDIT_MAX_PAGE_BYTES,
      AUDIT_MAX_PAGE_BYTES,
    ),
  };
}

/** A page can contain many evals for one run or runs for one benchmark. Keep
 * one promise per relationship so even concurrent callers perform one read. */
export function cachedAuditRead<Key extends string, Value>(
  read: (key: Key) => Promise<Value>,
): (key: Key) => Promise<Value> {
  const cache = new Map<Key, Promise<Value>>();
  return (key) => {
    const cached = cache.get(key);
    if (cached) return cached;
    const pending = read(key);
    cache.set(key, pending);
    return pending;
  };
}

/** Consume every page for all three tables before tightening. Counts describe
 * this page only, allowing a bounded caller to accumulate a complete audit. */
export const auditDocumentKinds = internalQuery({
  args: {
    table: v.union(
      v.literal("runs"),
      v.literal("evals"),
      v.literal("modelScores"),
    ),
    paginationOpts: paginationOptsValidator,
  },
  returns: v.object({
    table: v.union(
      v.literal("runs"),
      v.literal("evals"),
      v.literal("modelScores"),
    ),
    continueCursor: v.string(),
    isDone: v.boolean(),
    scanned: v.number(),
    missingKind: v.number(),
    coding: v.number(),
    decision: v.number(),
    codingByBenchmark: v.record(v.string(), v.number()),
    relationshipErrors: v.array(
      v.object({ id: v.string(), reason: v.string() }),
    ),
  }),
  handler: async (ctx, { table, paginationOpts }) => {
    const boundedPagination = boundedAuditPagination(paginationOpts);
    const counts = { missingKind: 0, coding: 0, decision: 0 };
    const codingByBenchmark: Record<string, number> = {};
    const relationshipErrors: Array<{ id: string; reason: string }> = [];
    const addBenchmark = (id: string) => {
      codingByBenchmark[id] = (codingByBenchmark[id] ?? 0) + 1;
    };
    const getRun = cachedAuditRead((id: Id<"runs">) => ctx.db.get("runs", id));
    const getBenchmark = cachedAuditRead((id: Id<"benchmarkVersions">) =>
      ctx.db.get("benchmarkVersions", id),
    );
    let continueCursor = "";
    let isDone = false;
    let scanned = 0;

    // Keep the table name literal in each branch. This preserves the generated
    // document type and lets us use the paged row directly instead of reading
    // every large document for a second time.
    switch (table) {
      case "runs": {
        const result = await ctx.db.query("runs").paginate(boundedPagination);
        continueCursor = result.continueCursor;
        isDone = result.isDone;
        scanned = result.page.length;
        for (const run of result.page) {
          counts[run.kind] += 1;
          if (run.kind === "coding") addBenchmark(run.benchmarkVersion);
          if (!(await getBenchmark(run.benchmarkVersion))) {
            relationshipErrors.push({
              id: run._id,
              reason: "Missing benchmark",
            });
          }
        }
        break;
      }
      case "evals": {
        const result = await ctx.db.query("evals").paginate(boundedPagination);
        continueCursor = result.continueCursor;
        isDone = result.isDone;
        scanned = result.page.length;
        for (const evalDoc of result.page) {
          counts[evalDoc.kind] += 1;
          const parent = await getRun(evalDoc.runId);
          if (!parent || parent.kind !== evalDoc.kind) {
            relationshipErrors.push({
              id: evalDoc._id,
              reason: "Missing or opposite-kind parent run",
            });
          } else if (evalDoc.kind === "coding")
            addBenchmark(parent.benchmarkVersion);
        }
        break;
      }
      case "modelScores": {
        const result = await ctx.db
          .query("modelScores")
          .paginate(boundedPagination);
        continueCursor = result.continueCursor;
        isDone = result.isDone;
        scanned = result.page.length;
        for (const score of result.page) {
          counts[score.kind] += 1;
          if (score.kind === "coding") addBenchmark(score.benchmarkVersion);
          const parent = await getRun(score.latestRunId);
          if (
            !parent ||
            parent.kind !== score.kind ||
            parent.benchmarkVersion !== score.benchmarkVersion
          ) {
            relationshipErrors.push({
              id: score._id,
              reason:
                "Missing, opposite-kind, or different-benchmark latest run",
            });
          }
        }
        break;
      }
      default:
        assertNever(table);
    }
    return {
      table,
      continueCursor,
      isDone,
      scanned,
      ...counts,
      codingByBenchmark,
      relationshipErrors,
    };
  },
});
