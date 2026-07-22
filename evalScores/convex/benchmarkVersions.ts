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
