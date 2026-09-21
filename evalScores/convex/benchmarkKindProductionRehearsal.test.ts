import { readFile } from "node:fs/promises";
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import {
  defineSchema,
  makeFunctionReference,
  type PaginationOptions,
  type FunctionReturnType,
} from "convex/server";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import { modules } from "./test.setup";

type Benchmark = Doc<"benchmarkVersions">;
const dryRun = makeFunctionReference<
  "query",
  { paginationOpts: PaginationOptions },
  {
    page: {
      before: Benchmark;
      after: Benchmark | null;
      error: string | null;
    }[];
    isDone: boolean;
    continueCursor: string;
  }
>("benchmarkKindMigration:dryRun");
const applyOne = makeFunctionReference<
  "mutation",
  { id: Id<"benchmarkVersions">; before: Benchmark; after: Benchmark | null },
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
    continueCursor: string;
  }
>("benchmarkKindMigration:audit");

// Only paths are configured here. Private production records never enter Git.
const prefix = process.env.BENCHMARK_REHEARSAL_SNAPSHOT_PREFIX;
describe.skipIf(!prefix)(
  "private production snapshot migration rehearsal",
  () => {
    it("migrates every benchmark while preserving all run/score fields and references", async () => {
      const versions = JSON.parse(
        await readFile(`${prefix}-versions.json`, "utf8"),
      ) as Benchmark[];
      const runs = JSON.parse(
        await readFile(`${prefix}-runs.json`, "utf8"),
      ) as Doc<"runs">[];
      const scores = JSON.parse(
        await readFile(`${prefix}-scores.json`, "utf8"),
      ) as Doc<"modelScores">[];
      // Convex-test IDs differ from production IDs. Keep opaque model/storage
      // foreign keys byte-for-byte instead of fabricating replacement evidence.
      // The normal migration tests cover validators with native fixture IDs.
      const t = convexTest(
        defineSchema(schema.tables, { schemaValidation: false }),
        modules,
      );
      const mapping = new Map<string, Id<"benchmarkVersions">>();
      for (const doc of versions) {
        const { _id, _creationTime, ...value } = doc;
        mapping.set(
          _id,
          await t.run((ctx) => ctx.db.insert("benchmarkVersions", value)),
        );
      }
      // The benchmark references must use fixture IDs. Other document fields,
      // including source/evidence identities and all numerical results, stay exact.
      for (const doc of runs) {
        const { _id, _creationTime, ...value } = doc;
        const benchmarkVersion = mapping.get(doc.benchmarkVersion);
        if (!benchmarkVersion)
          throw new Error("Snapshot has dangling run reference");
        await t.run((ctx) =>
          ctx.db.insert("runs", { ...value, benchmarkVersion }),
        );
      }
      for (const doc of scores) {
        const { _id, _creationTime, ...value } = doc;
        const benchmarkVersion = mapping.get(doc.benchmarkVersion);
        if (!benchmarkVersion)
          throw new Error("Snapshot has dangling score reference");
        await t.run((ctx) =>
          ctx.db.insert("modelScores", { ...value, benchmarkVersion }),
        );
      }
      const before = await t.run(async (ctx) => ({
        runs: await ctx.db.query("runs").collect(),
        scores: await ctx.db.query("modelScores").collect(),
      }));
      let cursor: string | null = null;
      let migrated = 0;
      do {
        const page: FunctionReturnType<typeof dryRun> = await t.query(dryRun, {
          paginationOpts: { cursor, numItems: 5 },
        });
        for (const entry of page.page) {
          expect(entry.error).toBeNull();
          await t.mutation(applyOne, {
            id: entry.before._id,
            before: entry.before,
            after: entry.after,
          });
          expect(await t.run((ctx) => ctx.db.get(entry.before._id))).toEqual(
            entry.after,
          );
          expect(
            await t.mutation(applyOne, {
              id: entry.before._id,
              before: entry.before,
              after: entry.after,
            }),
          ).toEqual({ changed: false });
          migrated++;
        }
        cursor = page.isDone ? null : page.continueCursor;
      } while (cursor);
      expect(migrated).toBe(versions.length);
      for (const [table, expected] of [
        ["benchmarkVersions", versions.length],
        ["runs", runs.length],
        ["modelScores", scores.length],
      ] as const) {
        let count = 0;
        cursor = null;
        do {
          const page: FunctionReturnType<typeof audit> = await t.query(audit, {
            table,
            paginationOpts: { cursor, numItems: 100 },
          });
          expect(page.missingKind).toBe(0);
          expect(page.relationshipErrors).toBe(0);
          count += page.scanned;
          cursor = page.isDone ? null : page.continueCursor;
        } while (cursor);
        expect(count).toBe(expected);
      }
      const after = await t.run(async (ctx) => ({
        runs: await ctx.db.query("runs").collect(),
        scores: await ctx.db.query("modelScores").collect(),
      }));
      expect(after).toEqual(before);
      expect(after.runs).toHaveLength(runs.length);
      expect(after.scores).toHaveLength(scores.length);
    }, 120_000);
  },
);
