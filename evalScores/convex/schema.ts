import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const experimentLiteral = v.union(v.literal("no_guidelines"));

// Step name as union of literals
const stepNameLiteral = v.union(
  v.literal("filesystem"),
  v.literal("install"),
  v.literal("deploy"),
  v.literal("tsc"),
  v.literal("eslint"),
  v.literal("tests"),
);

// Status discriminated unions
const runStatus = v.union(
  v.object({ kind: v.literal("pending") }),
  v.object({ kind: v.literal("running") }),
  v.object({ kind: v.literal("completed"), durationMs: v.number() }),
  v.object({ kind: v.literal("failed"), failureReason: v.string(), durationMs: v.number() }),
);

const evalStatus = v.union(
  v.object({ kind: v.literal("pending") }),
  v.object({ kind: v.literal("running") }),
  v.object({ kind: v.literal("passed"), durationMs: v.number(), outputStorageId: v.optional(v.id("_storage")) }),
  v.object({ kind: v.literal("failed"), failureReason: v.string(), durationMs: v.number(), outputStorageId: v.optional(v.id("_storage")) }),
);

const stepStatus = v.union(
  v.object({ kind: v.literal("running") }),
  v.object({ kind: v.literal("passed"), durationMs: v.number() }),
  v.object({ kind: v.literal("failed"), failureReason: v.string(), durationMs: v.number() }),
  v.object({ kind: v.literal("skipped") }),
);

export default defineSchema({
  // Each record is a single eval run for a model (append-only for history)
  evalScores: defineTable({
    model: v.string(),
    scores: v.record(v.string(), v.number()),
    totalScore: v.number(),
    // Optional run identifier (e.g. git sha, date string)
    runId: v.optional(v.string()),
    // Optional experiment tag for A/B testing different configurations
    experiment: v.optional(experimentLiteral),
  })
    .index("by_model", ["model"])
    .index("by_experiment", ["experiment"]),

  authTokens: defineTable({
    name: v.string(),
    value: v.string(),
    createdAt: v.number(),
    lastUsed: v.optional(v.number()),
  })
    .index("by_value", ["value"])
    .index("by_name", ["name"]),

  runs: defineTable({
    model: v.string(),
    provider: v.optional(v.string()),
    runId: v.optional(v.string()),
    plannedEvals: v.array(v.string()),
    status: runStatus,
    experiment: v.optional(experimentLiteral),
  })
    .index("by_model", ["model"])
    .index("by_experiment", ["experiment"]),

  evals: defineTable({
    runId: v.id("runs"),
    evalPath: v.string(),
    category: v.string(),
    name: v.string(),
    status: evalStatus,
    // Task description (from TASK.txt)
    task: v.optional(v.string()),
    // Reference to eval source files (answer dir, grader, etc.)
    evalSourceStorageId: v.optional(v.id("_storage")),
  })
    .index("by_runId", ["runId"])
    .index("by_evalPath", ["evalPath"]),

  // Stores hash -> storageId mapping for deduplication of eval assets
  evalAssets: defineTable({
    // MD5 hash of the content
    hash: v.string(),
    // Type of asset: "evalSource" for eval directory, "output" for model output
    assetType: v.union(v.literal("evalSource"), v.literal("output")),
    // Reference to the stored file
    storageId: v.id("_storage"),
  })
    .index("by_hash", ["hash"]),

  steps: defineTable({
    evalId: v.id("evals"),
    name: stepNameLiteral,
    status: stepStatus,
  })
    .index("by_evalId", ["evalId"]),
});
