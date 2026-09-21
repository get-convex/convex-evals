import { describe, expect, test } from "bun:test";
import { buildManifest } from "./benchmarkKindDryRun";
import {
  LEGACY_CODING_VERSION,
  LEGACY_DECISION_VERSION,
} from "../evalScores/convex/benchmarkKindMigration";
import type { Doc } from "../evalScores/convex/_generated/dataModel";
function fixtures() {
  const versions = [
    {
      _id: "coding-id",
      _creationTime: 1,
      version: LEGACY_CODING_VERSION,
      effectiveAt: 10,
      evalCount: 112,
      curatedModels: ["model"],
      provenance: "minted",
    },
    {
      _id: "decision-id",
      _creationTime: 2,
      version: LEGACY_DECISION_VERSION,
      effectiveAt: 20,
      evalCount: 112,
      curatedModels: [],
      provenance: "minted",
      decision: {
        protocolVersion: 1,
        sourceCommit: "a".repeat(40),
        sourceEvidence: { storageId: "storage-id", sha256: "b".repeat(64) },
        sources: [],
      },
    },
  ] as unknown as Doc<"benchmarkVersions">[];
  const runs = [
    {
      _id: "coding-run",
      kind: "coding" as const,
      benchmarkVersion: "coding-id",
    },
    {
      _id: "decision-run",
      kind: "decision" as const,
      benchmarkVersion: "decision-id",
    },
  ];
  return { versions, runs };
}
describe("offline benchmark migration manifest", () => {
  test("preserves full snapshots and reference IDs and rehearses idempotently", () => {
    const { versions, runs } = fixtures();
    const before = JSON.stringify({ versions, runs });
    const manifest = buildManifest(versions, runs, []);
    expect(manifest.summary.safeToMigrate).toBe(true);
    expect(manifest.entries[1].references.runs).toEqual(["decision-run"]);
    expect(manifest.entries[1].before).toEqual(versions[1]);
    expect(manifest.entries[1].after).toMatchObject({
      _id: "decision-id",
      codingBenchmarkVersion: "coding-id",
      kind: "decision",
    });
    expect(JSON.stringify({ versions, runs })).toBe(before);
    const retry = buildManifest(
      manifest.entries.map((e) => e.after!),
      runs,
      [],
    );
    expect(retry.summary).toMatchObject({ safeToMigrate: true, changed: 0 });
  });
  test("rejects wrong-kind scores and dangling runs", () => {
    const { versions, runs } = fixtures();
    const manifest = buildManifest(
      versions,
      [...runs, { _id: "bad", kind: "coding", benchmarkVersion: "missing" }],
      [{ _id: "score", kind: "coding", benchmarkVersion: "decision-id" }],
    );
    expect(manifest.summary.safeToMigrate).toBe(false);
    expect(manifest.summary.errors).toHaveLength(2);
  });
});
