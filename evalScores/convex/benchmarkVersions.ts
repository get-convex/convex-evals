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
type BackfillResult = {
  updated: number;
  alreadyAssigned: number;
  scoreGroupsQueued: number;
};

type ConsolidationResult = BackfillResult;

/**
 * Move an exact, audited set of historical runs into the full-content version
 * that represents the same suite. Unlike the original pre-mint backfill, this
 * deliberately allows multiple runs per model and models no longer curated.
 * Those runs are still valid observations of this benchmark.
 */
export async function consolidateCompletedBenchmarkRuns(
  ctx: MutationCtx,
  args: {
    sourceVersion: string;
    targetVersion: string;
    runIds: Id<"runs">[];
  },
): Promise<ConsolidationResult> {
  const [source, target] = await Promise.all(
    [args.sourceVersion, args.targetVersion].map((version) =>
      ctx.db
        .query("benchmarkVersions")
        .withIndex("by_version", (q) => q.eq("version", version))
        .unique(),
    ),
  );
  if (!source || source.provenance !== "reconstructed") {
    throw new Error(`Benchmark ${args.sourceVersion} is not reconstructed`);
  }
  if (!target || target.provenance !== "minted") {
    throw new Error(`Benchmark ${args.targetVersion} is not minted`);
  }
  if (source.evalCount !== target.evalCount) {
    throw new Error(
      `Benchmark eval counts differ (${source.evalCount} !== ${target.evalCount})`,
    );
  }

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

  // Validate the complete allowlist before writing anything. Convex mutations
  // are atomic, but doing this first also makes the operator failure clearer.
  const runs = await Promise.all(
    args.runIds.map(async (runId) => {
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
      if (
        run.benchmarkVersion !== source._id &&
        run.benchmarkVersion !== target._id
      ) {
        throw new Error(
          `Run ${runId} is in neither the source nor target benchmark`,
        );
      }
      return run;
    }),
  );

  for (const [index, run] of runs.entries()) {
    scoreGroups.set(`${run.modelId}:${run.experiment ?? "default"}`, {
      modelId: run.modelId,
      experiment: run.experiment,
    });
    if (run.benchmarkVersion === target._id) {
      alreadyAssigned += 1;
    } else {
      await ctx.db.patch("runs", args.runIds[index], {
        benchmarkVersion: target._id,
      });
      updated += 1;
    }
  }

  for (const group of scoreGroups.values()) {
    for (const benchmarkVersion of [source._id, target._id]) {
      await ctx.scheduler.runAfter(
        0,
        internal.modelScores.recomputeModelScores,
        { ...group, benchmarkVersion },
      );
    }
  }

  return {
    updated,
    alreadyAssigned,
    scoreGroupsQueued: scoreGroups.size,
  };
}

/** Plain helper so the guarded operation can be exercised with convex-test. */
export async function backfillCompletedRunsToBenchmark(
  ctx: MutationCtx,
  args: { version: string; runIds: Id<"runs">[] },
): Promise<BackfillResult> {
  const target = await ctx.db
    .query("benchmarkVersions")
    .withIndex("by_version", (q) => q.eq("version", args.version))
    .unique();
  if (!target || target.provenance === "unminted") {
    throw new Error(`Benchmark ${args.version} has not been minted`);
  }

  const unminted = await ctx.db
    .query("benchmarkVersions")
    .withIndex("by_version", (q) => q.eq("version", UNMINTED_BENCHMARK_VERSION))
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
}

const CURRENT_MANUAL_BACKFILL_VERSION =
  "e7c4fbad1ca9871e8d7af4e8d86a02038fb9852a52c8a240d44cecea3efc0afe";

// Audited from the successful main-branch manual workflows on 2026-07-22.
// Each workflow checked out commit 1b59e214966a5f172f204ffdd0417f4610487199,
// whose complete suite definition hashes to CURRENT_MANUAL_BACKFILL_VERSION.
// Keeping the exact IDs here prevents a same-sized but different suite from
// being reassigned by an operator-provided argument.
const CURRENT_MANUAL_BACKFILL_RUN_IDS = [
  "jn75xf33tdb88g2wbj4f6zfm8x8b0e6d",
  "jn73etgkjf8zwa16y8swtq9pvh8b1a5v",
  "jn785j9g3fwtmnz1sk44x76kjh8b0ef7",
  "jn742dqfsy47cgw45wbe3t3n7s8b17q9",
  "jn7dsr5gtdbzfv8k2b3nz1qrz58b07vh",
  "jn72b15qe4eahb3z9d3bcvn1qs8b1dz4",
  "jn7axrcbse17w1t20fvxxjtvdd8b0ynv",
  "jn77ymr0jn299wn4t6an1na1gh8b022e",
  "jn77fxwvmc1meeckg24akpec918b0gsb",
  "jn7fvxxcnewq4qjqbrd029m6bs8b14a1",
  "jn7d0s4pa4e45gne0dmfvf9wms8b1mve",
  "jn7cvbqwjqgbdchzsch35r5dxn8b03rx",
  "jn7fck01wk9bydyfg7ygwh4fa58b0mdj",
  "jn79rp6pf3r6pyffj19fjxcsqn8b13gy",
  "jn7ad1rzmkpgtjrqn0dkfwqsa58b0sc7",
  "jn70j5v8c5jk9gf60x1cpd56h18b10gj",
  "jn71zjh5pjzyr0wxm97knwrp7s8b0rg9",
  "jn7fqa8106b7zjcwq2e0wvmfj58b1wza",
  "jn7e08z5hb1j7sst1qk57de8g58b180j",
  "jn71vv212yr9w7de1eeqbhw4sx8b1530",
  "jn72ag8n4436p9d86c6ajapg4x8b1hme",
  "jn75scp603221e7c5cpmfmdk3x8b10c1",
] as Id<"runs">[];

/** One-off, idempotent production migration for the audited manual runs. */
export const backfillCurrentManualRunsToBenchmark = internalMutation({
  args: {},
  returns: v.object({
    updated: v.number(),
    alreadyAssigned: v.number(),
    scoreGroupsQueued: v.number(),
  }),
  handler: async (ctx) => {
    return await backfillCompletedRunsToBenchmark(ctx, {
      version: CURRENT_MANUAL_BACKFILL_VERSION,
      runIds: CURRENT_MANUAL_BACKFILL_RUN_IDS,
    });
  },
});

const JULY_20_RECONSTRUCTED_VERSION = "reconstructed-9e095e59f6d8";

// Audited from production leaderboard histories. All 28 runs were completed
// after the 109-eval suite landed at d36327c and before any eval, guideline,
// system-prompt, or protocol input changed. They therefore represent the same
// suite as CURRENT_MANUAL_BACKFILL_VERSION despite predating full-content IDs.
const JULY_20_RECONSTRUCTED_RUN_IDS = [
  "jn7bqz6xc617dnkgg04czah4hh8axhbv",
  "jn705x3qb9a4fwyd8dzmacwtq58ax477",
  "jn71rqtkzpp1z1wz8pkrcbg94n8awtt2",
  "jn7frsch2mt3emyc4gcq4y8ey58ax6dt",
  "jn76t8k2tg8h2gdb0z4bftv5398ax93b",
  "jn769zm219qwwxxprdv1qde24x8awaya",
  "jn7ahtbsyhg290prttfbcseqm58axh2n",
  "jn73kpfnx0fmkwc186kzdmccyx8axq3w",
  "jn73xdcx5geytf71g24qesvecd8ayzbx",
  "jn74tmyxfzw1242gj1b9p3fjxh8azct1",
  "jn736003hysktzxy83xm7j4efx8ay9t7",
  "jn76meza38rcp3p9qac0hnn5xh8ay7ke",
  "jn7ezxy8k86djdvh4rybq7ktv18azh70",
  "jn7dqp2ygg52v9t4hyp6y4vab98ay6jk",
  "jn7dek0yf2sb7e76xxebz8jhj18ayavt",
  "jn78t9ebb70fb09xvxaadyadcx8azcdn",
  "jn7at1xb2wt35j0kx1ddwrexq58azc1m",
  "jn7f0gy6tey28b8f6zhw4hnhdd8ay27g",
  "jn78m9sap2z497gh8qa77am77s8ay6c3",
  "jn765k2r4v0n8pr56qwkmhd9z98aymza",
  "jn75v4jbcqvvkmcyb0xdng6h6h8azmf1",
  "jn71sw7ce90hdtz5mg54k1gw498aybj2",
  "jn7b94apcx5q1cdq1my8t2z8tn8az982",
  "jn7azfx57c1684cy87nrpzbbqx8az8ya",
  "jn716ey8s1frh9rgeeg6shfvwx8az10g",
  "jn77heb5hv2hej9bdf5wg679sx8ay95y",
  "jn77dzc8zfratfdn8hd1k740858b0z63",
  "jn7bzrr4he51dr4rnxrncesw6x8b0m2d",
] as Id<"runs">[];

/** One-off, idempotent consolidation of the duplicate 109-eval partitions. */
export const consolidateJuly20Benchmark = internalMutation({
  args: {},
  returns: v.object({
    updated: v.number(),
    alreadyAssigned: v.number(),
    scoreGroupsQueued: v.number(),
  }),
  handler: async (ctx) => {
    return await consolidateCompletedBenchmarkRuns(ctx, {
      sourceVersion: JULY_20_RECONSTRUCTED_VERSION,
      targetVersion: CURRENT_MANUAL_BACKFILL_VERSION,
      runIds: JULY_20_RECONSTRUCTED_RUN_IDS,
    });
  },
});

// Audited 111-eval runs from main SHA 39065c99202097e2a80f690c22daf39fb6605d9c.
// The suite hash was computed from that exact clean checkout. Never absorb
// other runs just because they share the unminted bucket or eval count.
const SEPTEMBER_WEB_BENCHMARK =
  "6209c4a70d36b76ff4235b9da5f99933c8c65428e150d5445da5aadbf3d9c74a";
const SEPTEMBER_WEB_RUNS = {
  "1": [
    "jn7aztmg9pdt4dfh6xbbg0dfh58e0tgt",
    "jn7aapr9c0zz8m5mwx8tggt9c18e0zr1",
    "jn78g06cqn6x1b61rr06hq0yxn8e1gx1",
    "jn75fmf35pe1xankkgjj8swzrd8e044p",
    "jn76rgsnvqnsrfh5hbmf0qg9zx8e11n4",
    "jn784qv2x41mqywrhg0etrgvs58e1qsc",
    "jn7dhsfdghh3bqd9pbd378h2198e1txq",
    "jn7dzeh87rhnmv6r0skqt8xh6d8e1h51",
  ],
  "2": [
    "jn742gnhe9f06h2w3ft0p3wxx18e0t1r",
    "jn7fzkhqz6gcyzsn8325dbdcj98e0y1g",
    "jn716v8ce7gtnp2d0bsbs0v10d8e0nth",
    "jn7dg1y5d8n2j2952bksnkbakd8e224k",
    "jn7ej51sjx85hxjs7txqjgy6c58e3d30",
    "jn78p47gd0s077wytmwddd7r458e2ab9",
    "jn71spxs8wpd37tp7e6a85fs0x8e2zd4",
    "jn76kkkbtqjbp50ah5mxbvez8s8e28b5",
  ],
  "3": [
    "jn7e3ewhs4y8s76c64y19kyzjd8e3z2d",
    "jn74eapf7w7sd9g27fq9vheaq98e3vvz",
    "jn71c6hjc21mw0xt9grbmjdng18e264y",
    "jn72km9y3d7f9mde66rfz82pvx8e3qce",
    "jn7ash3daah3sg6w9h3e5fqsys8e3qqz",
    "jn70ny3tzb5bmycd2wdchvazd98e3gtd",
    "jn753q5xnkn026mgsy2rd9dyj18e2336",
    "jn71qq2nk39dkc0w73r355kqrx8e37dx",
  ],
} as const;

export const publishSeptemberWebRuns = internalMutation({
  args: { repetition: v.union(v.literal(1), v.literal(2), v.literal(3)) },
  returns: v.object({
    updated: v.number(),
    alreadyAssigned: v.number(),
    scoreGroupsQueued: v.number(),
  }),
  handler: async (ctx, args) => {
    const runIds = SEPTEMBER_WEB_RUNS[args.repetition].map(
      (id) => id as Id<"runs">,
    );
    // Check actual results as well as the plan before publishing this allowlist.
    for (const id of runIds) {
      const evals = await ctx.db
        .query("evals")
        .withIndex("by_runId", (q) => q.eq("runId", id))
        .take(112);
      if (
        evals.length !== 111 ||
        evals.some(
          (e) => e.status.kind !== "passed" && e.status.kind !== "failed",
        )
      ) {
        throw new Error(`Run ${id} does not have exactly 111 terminal evals`);
      }
    }
    return await backfillCompletedRunsToBenchmark(ctx, {
      version: SEPTEMBER_WEB_BENCHMARK,
      runIds,
    });
  },
});
