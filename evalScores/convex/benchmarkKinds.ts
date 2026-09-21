import type { Doc } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";

type Benchmark = Doc<"benchmarkVersions">;
export type CodingBenchmark = Extract<Benchmark, { kind: "coding" }>;
export type DecisionBenchmark = Extract<Benchmark, { kind: "decision" }>;
export type BenchmarkKind = "coding" | "decision";

export function benchmarkKind(doc: Benchmark): BenchmarkKind {
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
  if (doc.kind !== "coding") throw new Error("Expected coding benchmark");
  return doc;
}

export function requireDecisionBenchmark(doc: Benchmark): DecisionBenchmark {
  if (doc.kind !== "decision") throw new Error("Expected decision benchmark");
  return doc;
}

type Reader = Pick<QueryCtx, "db">;

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
  const docs = await ctx.db
    .query("benchmarkVersions")
    .withIndex("by_kind_effectiveAt", (q) => q.eq("kind", kind))
    .order("desc")
    .collect();
  return docs.map((doc) =>
    kind === "coding"
      ? requireCodingBenchmark(doc)
      : requireDecisionBenchmark(doc),
  );
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
  const doc = await ctx.db
    .query("benchmarkVersions")
    .withIndex("by_kind_version", (q) =>
      q.eq("kind", kind).eq("version", version),
    )
    .unique();
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
  const coding = await ctx.db.get(benchmark.codingBenchmarkVersion);
  if (!coding) throw new Error("Missing coding benchmark link");
  return requireCodingBenchmark(coding).evalCount;
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
  const doc = await ctx.db
    .query("benchmarkVersions")
    .withIndex("by_kind_effectiveAt", (q) => q.eq("kind", kind))
    .order("desc")
    .filter((q) => q.neq(q.field("provenance"), "unminted"))
    .first();
  return doc
    ? kind === "coding"
      ? requireCodingBenchmark(doc)
      : requireDecisionBenchmark(doc)
    : null;
}
