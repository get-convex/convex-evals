import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  type QueryCtx,
} from "./_generated/server";
import type { Doc } from "./_generated/dataModel";

export const LEGACY_DECISION_VERSION =
  "91852c9a25a98f75dcac6f6219d93e8c49f6caa5b2b6e12012ecb58ccffae522";
export const LEGACY_CODING_VERSION =
  "41d65c9b4f5bcdb97bc5c6ead5aa054e335b2eab6abc897b352b97b98b016fb3";
type Benchmark = Doc<"benchmarkVersions">;
type Reader = Pick<QueryCtx, "db">;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

export function intendedKind(doc: Benchmark): "coding" | "decision" {
  if ("kind" in doc) return doc.kind;
  if (doc.decision) {
    if (doc.version !== LEGACY_DECISION_VERSION)
      throw new Error(
        "Unknown legacy decision benchmark; explicit mapping required",
      );
    return "decision" as const;
  }
  if (doc.version === LEGACY_DECISION_VERSION)
    throw new Error("Known decision benchmark has lost its definition");
  return "coding" as const;
}

async function proposedDocument(
  ctx: Reader,
  doc: Benchmark,
): Promise<Benchmark> {
  const kind = intendedKind(doc);
  // An indexed existence check runs inside the write transaction, so even a
  // reference inserted after the dry run prevents an unsafe reclassification.
  const other = kind === "coding" ? "decision" : "coding";
  const [wrongRun, wrongScore, duplicate] = await Promise.all([
    ctx.db
      .query("runs")
      .withIndex("by_kind_benchmark_condition", (q) =>
        q.eq("kind", other).eq("benchmarkVersion", doc._id),
      )
      .first(),
    ctx.db
      .query("modelScores")
      .withIndex("by_kind_cohort", (q) =>
        q.eq("kind", other).eq("benchmarkVersion", doc._id),
      )
      .first(),
    ctx.db
      .query("benchmarkVersions")
      .withIndex("by_version", (q) => q.eq("version", doc.version))
      .take(3),
  ]);
  if (wrongRun || wrongScore)
    throw new Error("Mixed-kind benchmark references; migration refused");
  if (
    duplicate.length > 2 ||
    duplicate.some((row) => row._id !== doc._id && intendedKind(row) === kind)
  )
    throw new Error("Duplicate benchmark kind/version");
  const coding =
    kind === "decision" && !("kind" in doc)
      ? await ctx.db
          .query("benchmarkVersions")
          .withIndex("by_version", (q) =>
            q.eq("version", LEGACY_CODING_VERSION),
          )
          .unique()
      : null;
  return migrationDocument(doc, coding);
}

// Shared with the offline manifest builder; neither path rewrites evidence.
export function migrationDocument(
  doc: Benchmark,
  coding: Benchmark | null,
): Benchmark {
  const kind = intendedKind(doc);
  if ("kind" in doc) return doc;
  if (kind === "coding") return { ...doc, kind: "coding" };
  if (
    !coding ||
    intendedKind(coding) !== "coding" ||
    !("evalCount" in coding) ||
    coding.evalCount !== doc.evalCount
  )
    throw new Error("Missing or mismatched coding benchmark link");
  if (doc.provenance !== "minted" || !doc.decision)
    throw new Error("Decision benchmark must have a minted definition");
  const { evalCount: _count, curatedModels: _models, ...preserved } = doc;
  return {
    ...preserved,
    kind: "decision",
    provenance: "minted",
    identityFormat: "legacy_shared_v4",
    codingBenchmarkVersion: coding._id,
    decision: doc.decision,
  };
}

/** Save every page to a reviewed manifest before invoking applyOne. */
export const dryRun = internalQuery({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const page = await ctx.db.query("benchmarkVersions").paginate({
      ...args.paginationOpts,
      numItems: Math.min(args.paginationOpts.numItems, 50),
    });
    const entries = [];
    for (const before of page.page) {
      try {
        entries.push({
          before,
          after: await proposedDocument(ctx, before),
          error: null,
        });
      } catch (error) {
        entries.push({ before, after: null, error: String(error) });
      }
    }
    return { ...page, page: entries };
  },
});

/** The reviewed before/after snapshots are optimistic concurrency preconditions. */
export const applyOne = internalMutation({
  args: { id: v.id("benchmarkVersions"), before: v.any(), after: v.any() },
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.id);
    if (!doc) throw new Error("Benchmark was deleted since dry run");
    const proposed = await proposedDocument(ctx, doc);
    if (canonical(proposed) !== canonical(args.after))
      throw new Error("Proposed document differs from reviewed manifest");
    if (canonical(doc) === canonical(args.after)) return { changed: false };
    if (canonical(doc) !== canonical(args.before))
      throw new Error("Benchmark changed since dry run");
    const { _id, _creationTime, ...value } = proposed;
    await ctx.db.replace(_id, value);
    return { changed: true };
  },
});

/** Exhaust every table cursor; no page result alone is a strict-rollout gate. */
export const audit = internalQuery({
  args: {
    table: v.union(
      v.literal("benchmarkVersions"),
      v.literal("runs"),
      v.literal("modelScores"),
    ),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    const page = await ctx.db.query(args.table).paginate({
      ...args.paginationOpts,
      numItems: Math.min(args.paginationOpts.numItems, 100),
    });
    const errors: { id: string; reason: string }[] = [];
    let missingKind = 0;
    for (const row of page.page) {
      if (!("kind" in row)) missingKind++;
      if (args.table === "benchmarkVersions") {
        const doc = row as Benchmark;
        try {
          await proposedDocument(ctx, doc);
        } catch (error) {
          errors.push({ id: doc._id, reason: String(error) });
        }
        if ("kind" in doc && doc.kind === "decision") {
          const coding = await ctx.db.get(doc.codingBenchmarkVersion);
          if (!coding || !("kind" in coding) || coding.kind !== "coding")
            errors.push({
              id: doc._id,
              reason: "Dangling or non-coding source link",
            });
        }
      } else {
        const ref = row as Doc<"runs"> | Doc<"modelScores">;
        const benchmark = await ctx.db.get(ref.benchmarkVersion);
        if (!benchmark || !("kind" in benchmark) || benchmark.kind !== ref.kind)
          errors.push({
            id: ref._id,
            reason: "Missing or wrong-kind benchmark reference",
          });
      }
    }
    return {
      scanned: page.page.length,
      missingKind,
      relationshipErrors: errors.length,
      errors,
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    };
  },
});
