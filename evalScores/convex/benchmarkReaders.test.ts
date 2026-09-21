import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api } from "./_generated/api.js";
import schema from "./schema.js";
import { modules } from "./test.setup.js";

async function fixture() {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    const codingBenchmarkVersion = await ctx.db.insert("benchmarkVersions", {
      kind: "coding",
      version: "coding-september-10",
      effectiveAt: 10,
      evalCount: 112,
      curatedModels: [],
      provenance: "minted",
    });
    const storageId = await ctx.storage.store(new Blob(["source"]));
    await ctx.db.insert("benchmarkVersions", {
      kind: "decision",
      version: "decision-september-20",
      effectiveAt: 20,
      provenance: "minted",
      identityFormat: "decision_v1",
      codingBenchmarkVersion,
      decision: {
        protocolVersion: 1,
        sourceCommit: "a".repeat(40),
        sourceEvidence: { storageId, sha256: "1".repeat(64) },
        sources: [
          {
            evalPath: "cat/task",
            questions: [
              {
                id: "q",
                optionIds: ["a", "b", "c", "d"],
                correctOptionId: "a",
              },
            ],
          },
        ],
      },
    });
    // Publishing another coding release must not move the decision default.
    await ctx.db.insert("benchmarkVersions", {
      kind: "coding",
      version: "coding-september-21",
      effectiveAt: 21,
      evalCount: 113,
      curatedModels: [],
      provenance: "minted",
    });
  });
  return t;
}

describe("benchmark reader kind isolation", () => {
  it("keeps coding and decision selectors and defaults independent", async () => {
    const t = await fixture();
    const coding = await t.query(api.runs.leaderboardVersions, {});
    expect(
      coding
        .filter((version) => version.isCurrent)
        .map((version) => version.version),
    ).toEqual(["coding-september-21"]);
    expect(coding.map((version) => version.version)).not.toContain(
      "decision-september-20",
    );
    const decisions = await t.query(
      api.decisionViews.decisionLeaderboardVersions,
      {},
    );
    expect(decisions).toEqual([
      {
        version: "decision-september-20",
        effectiveAt: 20,
        codingEvalCount: 112,
        decisionSourceCount: 1,
        decisionQuestionCount: 1,
        decisionAvailable: true,
        isCurrent: true,
      },
    ]);
    const leaderboard = await t.query(api.decisionViews.decisionLeaderboard, {
      condition: "no_guidelines",
      paginationOpts: { cursor: null, numItems: 10 },
    });
    expect(leaderboard.benchmark?.version).toBe("decision-september-20");
    expect(leaderboard.benchmark?.codingEvalCount).toBe(112);
  });

  it("does not accept a coding version in decision reads", async () => {
    const t = await fixture();
    const result = await t.query(api.decisionViews.decisionLeaderboard, {
      benchmarkVersion: "coding-september-21",
      condition: "no_guidelines",
      paginationOpts: { cursor: null, numItems: 10 },
    });
    expect(result.availability).toBe("not_available");
    expect(result.benchmark).toBeNull();
    const runs = await t.query(api.decisionViews.listDecisionRuns, {
      benchmarkVersion: "coding-september-21",
      condition: "no_guidelines",
      paginationOpts: { cursor: null, numItems: 10 },
    });
    expect(runs.page).toEqual([]);
    expect(
      await t.query(api.runs.leaderboardScores, {
        benchmarkVersion: "decision-september-20",
      }),
    ).toEqual([]);
  });
});
