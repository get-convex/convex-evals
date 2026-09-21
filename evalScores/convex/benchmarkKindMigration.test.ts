import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, it } from "vitest";
import { makeFunctionReference, type PaginationOptions } from "convex/server";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import { modules } from "./test.setup";
import {
  LEGACY_CODING_VERSION,
  LEGACY_DECISION_VERSION,
} from "./benchmarkKindMigration";
type ManifestEntry = {
  before: Doc<"benchmarkVersions">;
  after: Doc<"benchmarkVersions"> | null;
  error: string | null;
};
const dryRun = makeFunctionReference<
  "query",
  { paginationOpts: PaginationOptions },
  { page: ManifestEntry[]; isDone: boolean; continueCursor: string }
>("benchmarkKindMigration:dryRun");
const applyOne = makeFunctionReference<
  "mutation",
  {
    id: Id<"benchmarkVersions">;
    before: Doc<"benchmarkVersions">;
    after: Doc<"benchmarkVersions"> | null;
  },
  { changed: boolean }
>("benchmarkKindMigration:applyOne");
const audit = makeFunctionReference<
  "query",
  {
    table: "benchmarkVersions" | "runs" | "modelScores";
    paginationOpts: PaginationOptions;
  },
  {
    scanned: number;
    missingKind: number;
    relationshipErrors: number;
    isDone: boolean;
  }
>("benchmarkKindMigration:audit");
async function fixture(): Promise<{
  t: TestConvex<typeof schema>;
  coding: Id<"benchmarkVersions">;
  decision: Id<"benchmarkVersions">;
  storageId: Id<"_storage">;
}> {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const storageId = await ctx.storage.store(
      new Blob(["immutable source evidence"]),
    );
    const coding = await ctx.db.insert("benchmarkVersions", {
      version: LEGACY_CODING_VERSION,
      effectiveAt: 10,
      evalCount: 112,
      curatedModels: ["old-model"],
      provenance: "minted",
    });
    const decision = await ctx.db.insert("benchmarkVersions", {
      version: LEGACY_DECISION_VERSION,
      effectiveAt: 20,
      evalCount: 112,
      curatedModels: [],
      provenance: "minted",
      decision: {
        protocolVersion: 1,
        sourceCommit: "a".repeat(40),
        sourceEvidence: { storageId, sha256: "b".repeat(64) },
        sources: [],
      },
    });
    return { coding, decision, storageId };
  });
  return { t, ...ids };
}
describe("benchmark kind migration", () => {
  it("preserves IDs, dates, coding metadata and source evidence, and can retry the reviewed manifest", async () => {
    const { t, coding, decision, storageId } = await fixture();
    const manifest = await t.query(dryRun, {
      paginationOpts: { cursor: null, numItems: 50 },
    });
    expect(manifest.isDone).toBe(true);
    for (const entry of manifest.page) {
      expect(entry.error).toBeNull();
      expect(
        await t.mutation(applyOne, {
          id: entry.before._id,
          before: entry.before,
          after: entry.after,
        }),
      ).toEqual({ changed: true });
      expect(
        await t.mutation(applyOne, {
          id: entry.before._id,
          before: entry.before,
          after: entry.after,
        }),
      ).toEqual({ changed: false });
    }
    const rows = await t.run(async (ctx) => ({
      coding: await ctx.db.get(coding),
      decision: await ctx.db.get(decision),
      blob: await (await ctx.storage.get(storageId))!.text(),
      count: (await ctx.db.query("benchmarkVersions").collect()).length,
    }));
    expect(rows.coding).toMatchObject({
      _id: coding,
      kind: "coding",
      effectiveAt: 10,
      evalCount: 112,
      curatedModels: ["old-model"],
    });
    expect(rows.decision).toMatchObject({
      _id: decision,
      kind: "decision",
      effectiveAt: 20,
      codingBenchmarkVersion: coding,
      identityFormat: "legacy_shared_v4",
      decision: { sourceEvidence: { storageId } },
    });
    expect(rows.decision).not.toHaveProperty("evalCount");
    expect(rows.decision).not.toHaveProperty("curatedModels");
    expect(rows.blob).toBe("immutable source evidence");
    expect(rows.count).toBe(2);
    expect(
      await t.query(audit, {
        table: "benchmarkVersions",
        paginationOpts: { cursor: null, numItems: 100 },
      }),
    ).toMatchObject({ missingKind: 0, relationshipErrors: 0, isDone: true });
  });
  it("rejects changed preconditions and unknown shared benchmarks", async () => {
    const { t, coding, decision } = await fixture();
    const manifest = await t.query(dryRun, {
      paginationOpts: { cursor: null, numItems: 50 },
    });
    const entry = manifest.page.find((x) => x.before._id === coding)!;
    await t.run((ctx) => ctx.db.patch(coding, { effectiveAt: 11 }));
    await expect(
      t.mutation(applyOne, {
        id: coding,
        before: entry.before,
        after: entry.after,
      }),
    ).rejects.toThrow("reviewed manifest");
    await t.run((ctx) => ctx.db.patch(decision, { version: "unknown-shared" }));
    const next = await t.query(dryRun, {
      paginationOpts: { cursor: null, numItems: 50 },
    });
    expect(next.page.find((x) => x.before._id === decision)!.error).toContain(
      "explicit mapping",
    );
  });
  it("blocks mixed references inserted after the dry run and leaves foreign keys intact", async () => {
    const { t, decision } = await fixture();
    const manifest = await t.query(dryRun, {
      paginationOpts: { cursor: null, numItems: 50 },
    });
    const entry = manifest.page.find((x) => x.before._id === decision)!;
    const runId = await t.run(async (ctx) => {
      const modelId = await ctx.db.insert("models", {
        slug: "test",
        formattedName: "Test",
        provider: "test",
        apiKind: "chat",
        openRouterFirstSeenAt: 0,
        createdAt: 0,
        updatedAt: 0,
        lastSeenAt: 0,
      });
      return ctx.db.insert("runs", {
        kind: "coding",
        modelId,
        provider: "test",
        plannedEvals: [],
        benchmarkVersion: decision,
        status: { kind: "running" },
      });
    });
    await expect(
      t.mutation(applyOne, {
        id: decision,
        before: entry.before,
        after: entry.after,
      }),
    ).rejects.toThrow("Mixed-kind");
    expect(await t.run((ctx) => ctx.db.get(runId))).toMatchObject({
      _id: runId,
      benchmarkVersion: decision,
    });
  });
});
