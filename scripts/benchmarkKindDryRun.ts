import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Doc } from "../evalScores/convex/_generated/dataModel";
import {
  intendedKind,
  migrationDocument,
  LEGACY_CODING_VERSION,
} from "../evalScores/convex/benchmarkKindMigration";

type Benchmark = Doc<"benchmarkVersions">;
type Reference = {
  _id: string;
  kind: "coding" | "decision";
  benchmarkVersion: string;
};
export function buildManifest(
  versions: Benchmark[],
  runs: Reference[],
  scores: Reference[],
) {
  const errors: string[] = [];
  const byId = new Map(versions.map((v) => [v._id as string, v]));
  if (byId.size !== versions.length)
    errors.push("Duplicate benchmark document IDs");
  const codingMatches = versions.filter(
    (v) => v.version === LEGACY_CODING_VERSION,
  );
  if (codingMatches.length !== 1)
    errors.push("Expected exactly one approved coding source benchmark");
  const keys = new Set<string>();
  const refs = new Map<string, { runs: string[]; scores: string[] }>();
  for (const [table, rows] of [
    ["runs", runs],
    ["scores", scores],
  ] as const) {
    const ids = new Set<string>();
    for (const row of rows) {
      if (ids.has(row._id))
        errors.push(`${table}/${row._id}: duplicate document ID`);
      ids.add(row._id);
      const bucket = refs.get(row.benchmarkVersion) ?? { runs: [], scores: [] };
      bucket[table].push(row._id);
      refs.set(row.benchmarkVersion, bucket);
      const benchmark = byId.get(row.benchmarkVersion);
      try {
        if (!benchmark) throw new Error("dangling benchmark reference");
        if (row.kind !== intendedKind(benchmark))
          throw new Error("missing or mismatched reference kind");
      } catch (error) {
        errors.push(`${table}/${row._id}: ${String(error)}`);
      }
    }
  }
  const entries = versions.map((before) => {
    let after: Benchmark | null = null;
    try {
      after = migrationDocument(before, codingMatches[0] ?? null);
      const key = `${intendedKind(after)}:${after.version}`;
      if (keys.has(key)) throw new Error("duplicate benchmark kind/version");
      keys.add(key);
      if ("kind" in after && after.kind === "decision") {
        const linked = byId.get(after.codingBenchmarkVersion);
        if (!linked || intendedKind(linked) !== "coding")
          throw new Error("invalid coding source link");
      }
    } catch (error) {
      errors.push(`benchmarkVersions/${before._id}: ${String(error)}`);
    }
    return {
      before,
      after,
      references: refs.get(before._id) ?? { runs: [], scores: [] },
    };
  });
  return {
    summary: {
      safeToMigrate: errors.length === 0,
      counts: {
        benchmarkVersions: versions.length,
        runs: runs.length,
        modelScores: scores.length,
      },
      changed: entries.filter(
        (e) => JSON.stringify(e.before) !== JSON.stringify(e.after),
      ).length,
      coding: entries.filter(
        (e) => e.after && "kind" in e.after && e.after.kind === "coding",
      ).length,
      decision: entries.filter(
        (e) => e.after && "kind" in e.after && e.after.kind === "decision",
      ).length,
      errors,
    },
    entries,
  };
}

async function main() {
  const [versionsPath, runsPath, scoresPath, outPath] = process.argv.slice(2);
  if (!versionsPath || !runsPath || !scoresPath || !outPath)
    throw new Error(
      "Usage: bun scripts/benchmarkKindDryRun.ts versions.json runs.json scores.json output-directory",
    );
  const paths = [versionsPath, runsPath, scoresPath];
  const files = await Promise.all(paths.map((path) => readFile(path, "utf8")));
  const parsed = files.map((contents, index) => {
    const docs = JSON.parse(contents);
    if (!Array.isArray(docs))
      throw new Error(`Expected an exhaustive JSON array in ${paths[index]}`);
    return docs;
  });
  const manifest = buildManifest(parsed[0], parsed[1], parsed[2]);
  const metadata = {
    generatedAt: new Date().toISOString(),
    offline: true,
    inputs: paths.map((path, i) => ({
      path: resolve(path),
      sha256: createHash("sha256").update(files[i]).digest("hex"),
    })),
    note: "Read-only snapshot review. Recheck writer quiescence, full export counts and manifest preconditions immediately before applying.",
  };
  await mkdir(outPath, { recursive: true, mode: 0o700 });
  await writeFile(
    resolve(outPath, "manifest.json"),
    JSON.stringify({ ...metadata, ...manifest }, null, 2),
    { mode: 0o600 },
  );
  await writeFile(
    resolve(outPath, "summary.json"),
    JSON.stringify({ ...metadata, ...manifest.summary }, null, 2),
    { mode: 0o600 },
  );
  console.log(JSON.stringify(manifest.summary, null, 2));
  if (!manifest.summary.safeToMigrate) process.exitCode = 1;
}
if (import.meta.main) await main();
