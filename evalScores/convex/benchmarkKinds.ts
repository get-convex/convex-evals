import type { Doc } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";

type Benchmark = Doc<"benchmarkVersions">;
export type CodingBenchmark = Extract<Benchmark, { kind: "coding" }>;
export type DecisionBenchmark = Omit<
  Extract<Benchmark, { kind: "decision" }>,
  "codingBenchmarkVersion"
> & {
  codingBenchmarkVersion?: Extract<
    Benchmark,
    { kind: "decision" }
  >["codingBenchmarkVersion"];
  evalCount?: number;
};
export type BenchmarkKind = "coding" | "decision";

export function benchmarkKind(doc: Benchmark): BenchmarkKind {
  if (!("kind" in doc)) return doc.decision ? "decision" : "coding";
  switch (doc.kind) {
    case "coding":
      return "coding";
    case "decision":
      return "decision";
    default: {
      const exhaustive: never = doc;
      throw new Error(`Unknown benchmark kind: ${String(exhaustive)}`);
    }
  }
}

export function requireCodingBenchmark(doc: Benchmark): CodingBenchmark {
  if (benchmarkKind(doc) !== "coding")
    throw new Error("Expected coding benchmark");
  if ("kind" in doc) return doc as CodingBenchmark;
  const { decision: _, ...coding } = doc;
  return { ...coding, kind: "coding" } as CodingBenchmark;
}

export function requireDecisionBenchmark(doc: Benchmark): DecisionBenchmark {
  if (benchmarkKind(doc) !== "decision")
    throw new Error("Expected decision benchmark");
  if ("kind" in doc) return doc as Extract<Benchmark, { kind: "decision" }>;
  if (!doc.decision || doc.provenance !== "minted")
    throw new Error("Unminted decision benchmark");
  return {
    ...doc,
    kind: "decision",
    provenance: "minted",
    identityFormat: "legacy_shared_v4",
    decision: doc.decision,
  };
}

type Reader = Pick<QueryCtx, "db">;
// Temporary migration fallback. Fail closed rather than silently truncate a
// growing legacy set. Remove after the strict audit and compatibility window.
async function legacyBenchmarks(ctx: Reader): Promise<Benchmark[]> {
  const docs = await ctx.db
    .query("benchmarkVersions")
    .withIndex("by_kind_effectiveAt", (q) => q.eq("kind", undefined))
    .take(1001);
  if (docs.length > 1000)
    throw new Error("Legacy benchmark migration required");
  return docs;
}

export function listBenchmarksByKind(
  ctx: Reader,
  kind: "coding",
): Promise<CodingBenchmark[]>;
export function listBenchmarksByKind(
  ctx: Reader,
  kind: "decision",
): Promise<DecisionBenchmark[]>;
export async function listBenchmarksByKind(
  ctx: Reader,
  kind: BenchmarkKind,
): Promise<(CodingBenchmark | DecisionBenchmark)[]> {
  const [tagged, legacy] = await Promise.all([
    ctx.db
      .query("benchmarkVersions")
      .withIndex("by_kind_effectiveAt", (q) => q.eq("kind", kind))
      .order("desc")
      .collect(),
    legacyBenchmarks(ctx),
  ]);
  return [...tagged, ...legacy.filter((doc) => benchmarkKind(doc) === kind)]
    .map((doc) =>
      kind === "coding"
        ? requireCodingBenchmark(doc)
        : requireDecisionBenchmark(doc),
    )
    .sort((a, b) => b.effectiveAt - a.effectiveAt);
}

export function findBenchmarkByKind(
  ctx: Reader,
  kind: "coding",
  version: string,
): Promise<CodingBenchmark | null>;
export function findBenchmarkByKind(
  ctx: Reader,
  kind: "decision",
  version: string,
): Promise<DecisionBenchmark | null>;
export async function findBenchmarkByKind(
  ctx: Reader,
  kind: BenchmarkKind,
  version: string,
): Promise<CodingBenchmark | DecisionBenchmark | null> {
  const [tagged, legacy] = await Promise.all([
    ctx.db
      .query("benchmarkVersions")
      .withIndex("by_kind_version", (q) =>
        q.eq("kind", kind).eq("version", version),
      )
      .unique(),
    ctx.db
      .query("benchmarkVersions")
      .withIndex("by_kind_version", (q) =>
        q.eq("kind", undefined).eq("version", version),
      )
      .take(2),
  ]);
  const matches = [
    ...(tagged ? [tagged] : []),
    ...legacy.filter((doc) => benchmarkKind(doc) === kind),
  ];
  if (matches.length > 1) throw new Error("Duplicate benchmark kind/version");
  const doc = matches[0];
  return doc
    ? kind === "coding"
      ? requireCodingBenchmark(doc)
      : requireDecisionBenchmark(doc)
    : null;
}

export async function decisionCodingEvalCount(
  ctx: Reader,
  benchmark: DecisionBenchmark,
): Promise<number> {
  if (benchmark.codingBenchmarkVersion) {
    const coding = await ctx.db.get(benchmark.codingBenchmarkVersion);
    if (!coding) throw new Error("Missing coding benchmark link");
    return requireCodingBenchmark(coding).evalCount;
  }
  if (benchmark.evalCount === undefined)
    throw new Error("Missing legacy coding coverage");
  return benchmark.evalCount;
}

export function latestBenchmarkByKind(
  ctx: Reader,
  kind: "coding",
): Promise<CodingBenchmark | null>;
export function latestBenchmarkByKind(
  ctx: Reader,
  kind: "decision",
): Promise<DecisionBenchmark | null>;
export async function latestBenchmarkByKind(
  ctx: Reader,
  kind: BenchmarkKind,
): Promise<CodingBenchmark | DecisionBenchmark | null> {
  const [tagged, legacy] = await Promise.all([
    ctx.db
      .query("benchmarkVersions")
      .withIndex("by_kind_effectiveAt", (q) => q.eq("kind", kind))
      .order("desc")
      .filter((q) => q.neq(q.field("provenance"), "unminted"))
      .first(),
    legacyBenchmarks(ctx),
  ]);
  const candidates = [
    ...(tagged ? [tagged] : []),
    ...legacy.filter(
      (doc) => benchmarkKind(doc) === kind && doc.provenance !== "unminted",
    ),
  ];
  candidates.sort((a, b) => b.effectiveAt - a.effectiveAt);
  const doc = candidates[0];
  return doc
    ? kind === "coding"
      ? requireCodingBenchmark(doc)
      : requireDecisionBenchmark(doc)
    : null;
}
