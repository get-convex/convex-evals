import { internal } from "./_generated/api";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import {
  HISTORICAL_BENCHMARKS,
  UNMINTED_BENCHMARK_VERSION,
} from "./historicalBenchmarks";

async function getOrCreateUnmintedBenchmark(
  ctx: Pick<MutationCtx, "db">,
): Promise<Doc<"benchmarkVersions">> {
  const existing = await ctx.db
    .query("benchmarkVersions")
    .withIndex("by_version", (q) => q.eq("version", UNMINTED_BENCHMARK_VERSION))
    .unique();
  if (existing) return existing;

  const id = await ctx.db.insert("benchmarkVersions", {
    version: UNMINTED_BENCHMARK_VERSION,
    effectiveAt: 0,
    evalCount: 0,
    curatedModels: [],
    provenance: "unminted",
  });
  return (await ctx.db.get(id))!;
}

/**
 * Resolve the runner's deterministic suite hash to a manually minted version.
 * Unknown hashes deliberately share one non-public record until the user mints
 * that suite. This keeps the run foreign key required without publishing a
 * benchmark version automatically.
 */
export async function resolveBenchmarkForRun(
  ctx: Pick<MutationCtx, "db">,
  versionHash: string | undefined,
): Promise<Id<"benchmarkVersions">> {
  if (versionHash !== undefined) {
    const existing = await ctx.db
      .query("benchmarkVersions")
      .withIndex("by_version", (q) => q.eq("version", versionHash))
      .unique();
    if (existing && existing.provenance !== "unminted") return existing._id;
  }

  return (await getOrCreateUnmintedBenchmark(ctx))._id;
}

/** Seed the exact reconstructed cohorts found by the production run audit. */
export const seedHistorical = internalMutation({
  args: {},
  returns: v.object({ created: v.number(), existing: v.number() }),
  handler: async (ctx) => {
    let created = 0;
    let existing = 0;

    for (const benchmark of HISTORICAL_BENCHMARKS) {
      const found = await ctx.db
        .query("benchmarkVersions")
        .withIndex("by_version", (q) => q.eq("version", benchmark.version))
        .unique();
      if (found) {
        existing += 1;
        continue;
      }
      await ctx.db.insert("benchmarkVersions", {
        version: benchmark.version,
        effectiveAt: benchmark.effectiveAt,
        evalCount: benchmark.evalCount,
        curatedModels: [],
        provenance: "reconstructed",
      });
      created += 1;
    }

    const unminted = await ctx.db
      .query("benchmarkVersions")
      .withIndex("by_version", (q) =>
        q.eq("version", UNMINTED_BENCHMARK_VERSION),
      )
      .unique();
    if (unminted) {
      existing += 1;
    } else {
      await getOrCreateUnmintedBenchmark(ctx);
      created += 1;
    }

    return { created, existing };
  },
});

/**
 * Minting is explicit and metadata-only. It resolves future runs with this
 * exact hash to the new version but never schedules paid model runs.
 */
export const mint = internalMutation({
  args: {
    version: v.string(),
    evalCount: v.number(),
    curatedModels: v.array(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("benchmarkVersions")
      .withIndex("by_version", (q) => q.eq("version", args.version))
      .unique();

    if (existing) {
      await ctx.db.patch("benchmarkVersions", existing._id, {
        evalCount: args.evalCount,
        curatedModels: args.curatedModels,
        provenance: "minted",
        ...(existing.provenance === "minted"
          ? {}
          : { effectiveAt: Date.now() }),
      });
    } else {
      await ctx.db.insert("benchmarkVersions", {
        version: args.version,
        effectiveAt: Date.now(),
        evalCount: args.evalCount,
        curatedModels: args.curatedModels,
        provenance: "minted",
      });
    }

    return null;
  },
});

/**
 * Move explicitly selected completed full-suite runs out of the non-public
 * unminted bucket after their exact benchmark hash has been manually minted.
 *
 * This is deliberately ID-driven rather than date-driven. A date range could
 * silently absorb unrelated experiments or partial runs that happened to use
 * the same temporary bucket.
 */
export const backfillCompletedRunsToBenchmark = internalMutation({
  args: {
    version: v.string(),
    runIds: v.array(v.id("runs")),
  },
  returns: v.object({
    updated: v.number(),
    alreadyAssigned: v.number(),
    scoreGroupsQueued: v.number(),
  }),
  handler: async (ctx, args) => {
    const target = await ctx.db
      .query("benchmarkVersions")
      .withIndex("by_version", (q) => q.eq("version", args.version))
      .unique();
    if (!target || target.provenance === "unminted") {
      throw new Error(`Benchmark ${args.version} has not been minted`);
    }

    const unminted = await ctx.db
      .query("benchmarkVersions")
      .withIndex("by_version", (q) => q.eq("version", "unminted"))
      .unique();
    if (!unminted) throw new Error("Missing unminted benchmark sentinel");

    const uniqueRunIds = new Set(args.runIds.map(String));
    if (uniqueRunIds.size !== args.runIds.length) {
      throw new Error("Run IDs must be unique");
    }

    let updated = 0;
    let alreadyAssigned = 0;
    const scoreGroups = new Map<
      string,
      { modelId: Id<"models">; experiment: Doc<"runs">["experiment"] }
    >();

    for (const runId of args.runIds) {
      const run = await ctx.db.get("runs", runId);
      if (!run) throw new Error(`Run ${runId} does not exist`);
      if (run.status.kind !== "completed") {
        throw new Error(`Run ${runId} is not completed`);
      }
      if (run.plannedEvals.length !== target.evalCount) {
        throw new Error(
          `Run ${runId} planned ${run.plannedEvals.length} evals, expected ${target.evalCount}`,
        );
      }

      const model = await ctx.db.get("models", run.modelId);
      if (!model || !target.curatedModels.includes(model.slug)) {
        throw new Error(`Run ${runId} is not for a curated benchmark model`);
      }

      const groupKey = `${run.modelId}:${run.experiment ?? "default"}`;
      if (scoreGroups.has(groupKey)) {
        throw new Error(
          `Only one run per model and experiment may be backfilled at once (${groupKey})`,
        );
      }
      scoreGroups.set(groupKey, {
        modelId: run.modelId,
        experiment: run.experiment,
      });

      if (run.benchmarkVersion === target._id) {
        alreadyAssigned += 1;
        continue;
      }
      if (run.benchmarkVersion !== unminted._id) {
        throw new Error(`Run ${runId} is not in the unminted benchmark`);
      }

      await ctx.db.patch("runs", runId, { benchmarkVersion: target._id });
      updated += 1;
    }

    for (const group of scoreGroups.values()) {
      // Recompute both partitions so retrying this operation is idempotent and
      // any stale derived row in the unminted bucket is also removed.
      for (const benchmarkVersion of [unminted._id, target._id]) {
        await ctx.scheduler.runAfter(
          0,
          internal.modelScores.recomputeModelScores,
          {
            ...group,
            benchmarkVersion,
          },
        );
      }
    }

    return {
      updated,
      alreadyAssigned,
      scoreGroupsQueued: scoreGroups.size,
    };
  },
});
