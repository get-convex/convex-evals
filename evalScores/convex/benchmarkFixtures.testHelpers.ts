import { defineSchema, defineTable } from "convex/server";
import { v, type Infer } from "convex/values";
import schema, {
  legacyBenchmark,
  codingBenchmark,
  decisionBenchmark,
} from "./schema";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";

// Only migration rehearsals accept historical input shapes. Normal tests use
// the deployed strict schema, including all newly written benchmark fixtures.
export const compatibilitySchema = defineSchema({
  ...schema.tables,
  benchmarkVersions: defineTable(
    v.union(legacyBenchmark, codingBenchmark, decisionBenchmark),
  )
    .index("by_version", ["version"])
    .index("by_effectiveAt", ["effectiveAt"])
    .index("by_kind_version", ["kind", "version"])
    .index("by_kind_effectiveAt", ["kind", "effectiveAt"]),
});

export async function insertDecisionBenchmark(
  ctx: Pick<MutationCtx, "db">,
  fixture: Infer<typeof legacyBenchmark> & {
    decision: Infer<typeof decisionBenchmark>["decision"];
  },
): Promise<Id<"benchmarkVersions">> {
  const codingBenchmarkVersion = await ctx.db.insert("benchmarkVersions", {
    kind: "coding",
    version: `${fixture.version}-coding-source`,
    effectiveAt: fixture.effectiveAt,
    evalCount: fixture.evalCount,
    curatedModels: fixture.curatedModels,
    provenance: "minted",
  });
  return await ctx.db.insert("benchmarkVersions", {
    kind: "decision",
    version: fixture.version,
    effectiveAt: fixture.effectiveAt,
    provenance: "minted",
    identityFormat: "legacy_shared_v4",
    codingBenchmarkVersion,
    decision: fixture.decision,
  });
}
