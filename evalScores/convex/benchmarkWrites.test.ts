import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { internal } from "./_generated/api.js";
import schema from "./schema.js";
import { modules } from "./test.setup.js";
import { resolveBenchmarkForRun } from "./benchmarkVersions.js";

async function fixture(
  identityFormat: "legacy_shared_v4" | "decision_v1" = "decision_v1",
) {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const coding = await ctx.db.insert("benchmarkVersions", {
      kind: "coding",
      version: "coding",
      effectiveAt: 10,
      evalCount: 112,
      curatedModels: [],
      provenance: "minted",
    });
    const storageId = await ctx.storage.store(new Blob(["original archive"]));
    const definition = {
      protocolVersion: 1,
      sourceCommit: "a".repeat(40),
      sourceEvidence: { storageId, sha256: "1".repeat(64) },
      sources: [
        {
          evalPath: "cat/task",
          questions: [
            { id: "q", optionIds: ["a", "b", "c", "d"], correctOptionId: "a" },
          ],
        },
      ],
    };
    const decision = await ctx.db.insert("benchmarkVersions", {
      kind: "decision",
      version: "decision",
      effectiveAt: 20,
      provenance: "minted",
      identityFormat,
      codingBenchmarkVersion: coding,
      decision: definition,
    });
    return { coding, decision, definition };
  });
  return { t, ...ids };
}

describe("benchmark write kind and identity guards", () => {
  it("rejects a known decision hash instead of creating a coding unminted run", async () => {
    const { t } = await fixture();
    await expect(
      t.run((ctx) => resolveBenchmarkForRun(ctx, "decision")),
    ).rejects.toThrow("received decision version");
    const id = await t.run((ctx) =>
      resolveBenchmarkForRun(ctx, "unpublished-coding"),
    );
    const bucket = await t.run((ctx) => ctx.db.get(id));
    expect(bucket).toMatchObject({ kind: "coding", provenance: "unminted" });
  });

  it("refuses a coding replay that would alter linked decision coverage", async () => {
    const { t, coding } = await fixture();
    await expect(
      t.mutation(internal.benchmarkVersions.mint, {
        version: "coding",
        evalCount: 113,
        curatedModels: [],
      }),
    ).rejects.toThrow("eval count is immutable");
    await t.mutation(internal.benchmarkVersions.mint, {
      version: "coding",
      evalCount: 112,
      curatedModels: ["updated-model"],
    });
    expect(await t.run((ctx) => ctx.db.get(coding))).toMatchObject({
      evalCount: 112,
      effectiveAt: 10,
      curatedModels: ["updated-model"],
    });
  });

  it("preserves the original decision_v1 archive on verified semantic replay", async () => {
    const { t, decision, definition } = await fixture();
    const before = await t.run((ctx) => ctx.db.get(decision));
    const storageId = await t.run((ctx) =>
      ctx.storage.store(new Blob(["reporting refactor archive"])),
    );
    await t.mutation(internal.benchmarkVersions.mint, {
      version: "decision",
      evalCount: 112,
      curatedModels: [],
      identityFormat: "decision_v1",
      codingBenchmarkVersionHash: "coding",
      decision: {
        ...definition,
        sourceCommit: "b".repeat(40),
        sourceEvidence: { storageId, sha256: "2".repeat(64) },
      },
    });
    expect(await t.run((ctx) => ctx.db.get(decision))).toEqual(before);
    await expect(
      t.mutation(internal.benchmarkVersions.mint, {
        version: "decision",
        evalCount: 112,
        curatedModels: [],
        identityFormat: "decision_v1",
        codingBenchmarkVersionHash: "coding",
        decision: {
          ...definition,
          sources: [
            {
              ...definition.sources[0],
              questions: [
                { ...definition.sources[0].questions[0], correctOptionId: "b" },
              ],
            },
          ],
        },
      }),
    ).rejects.toThrow("different immutable decision definition");
  });

  it("keeps legacy shared archives immutable on replay", async () => {
    const { t, definition } = await fixture("legacy_shared_v4");
    await expect(
      t.mutation(internal.benchmarkVersions.mint, {
        version: "decision",
        evalCount: 112,
        curatedModels: [],
        identityFormat: "legacy_shared_v4",
        codingBenchmarkVersionHash: "coding",
        decision: { ...definition, sourceCommit: "b".repeat(40) },
      }),
    ).rejects.toThrow("different immutable decision definition");
  });
});

describe("strict benchmark schema", () => {
  it("rejects untagged rows and decision records without a source link", async () => {
    const { t, definition } = await fixture();
    await expect(
      t.run((ctx) =>
        ctx.db.insert("benchmarkVersions", {
          version: "untagged",
          effectiveAt: 1,
          evalCount: 1,
          curatedModels: [],
          provenance: "minted",
        } as never),
      ),
    ).rejects.toThrow();
    await expect(
      t.run((ctx) =>
        ctx.db.insert("benchmarkVersions", {
          kind: "decision",
          version: "unlinked",
          effectiveAt: 1,
          provenance: "minted",
          identityFormat: "legacy_shared_v4",
          decision: definition,
        } as never),
      ),
    ).rejects.toThrow();
  });

  it("rejects new decision mints without a coding source for either identity format", async () => {
    const { t, definition } = await fixture();
    for (const identityFormat of ["decision_v1", "legacy_shared_v4"] as const) {
      await expect(
        t.mutation(internal.benchmarkVersions.mint, {
          version: `unlinked-${identityFormat}`,
          evalCount: 112,
          curatedModels: [],
          decision: definition,
          identityFormat,
        }),
      ).rejects.toThrow("Coding benchmark link required");
    }
    expect(
      await t.run((ctx) => ctx.db.query("benchmarkVersions").collect()),
    ).toHaveLength(2);
  });
});
