import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const experimentLiteral = v.union(
  v.literal("no_guidelines"),
  v.literal("web_search"),
  v.literal("web_search_no_guidelines"),
  v.literal("agents_md"),
);

// Step name as union of literals
export const stepNameLiteral = v.union(
  v.literal("filesystem"),
  v.literal("install"),
  v.literal("deploy"),
  v.literal("tsc"),
  v.literal("eslint"),
  v.literal("tests"),
);

// Mirrors the LanguageModelUsage type from the Vercel AI SDK (ai package).
// All fields are optional in the validator because JSON serialization strips
// undefined values before storage. The `raw` field holds the unmodified
// provider response (OpenRouter-specific fields like cost, is_byok, etc.) and
// uses v.any() since its shape is opaque and varies by provider.
export const languageModelUsage = v.object({
  inputTokens: v.optional(v.number()),
  inputTokenDetails: v.optional(v.object({
    noCacheTokens: v.optional(v.number()),
    cacheReadTokens: v.optional(v.number()),
    cacheWriteTokens: v.optional(v.number()),
  })),
  outputTokens: v.optional(v.number()),
  outputTokenDetails: v.optional(v.object({
    textTokens: v.optional(v.number()),
    reasoningTokens: v.optional(v.number()),
  })),
  totalTokens: v.optional(v.number()),
  // Deprecated SDK fields, kept for backward compat with stored data
  reasoningTokens: v.optional(v.number()),
  cachedInputTokens: v.optional(v.number()),
  // Unmodified provider response - shape varies by provider
  raw: v.optional(v.any()),
});

export const runStatus = v.union(
  v.object({ kind: v.literal("pending") }),
  v.object({ kind: v.literal("running") }),
  v.object({ kind: v.literal("completed"), durationMs: v.number(), usage: v.optional(languageModelUsage) }),
  v.object({ kind: v.literal("failed"), failureReason: v.string(), durationMs: v.number(), usage: v.optional(languageModelUsage) }),
);

export const evalStatus = v.union(
  v.object({ kind: v.literal("pending") }),
  v.object({ kind: v.literal("running"), outputStorageId: v.optional(v.id("_storage")) }),
  v.object({ kind: v.literal("passed"), durationMs: v.number(), outputStorageId: v.optional(v.id("_storage")), usage: v.optional(languageModelUsage) }),
  v.object({ kind: v.literal("failed"), failureReason: v.string(), durationMs: v.number(), outputStorageId: v.optional(v.id("_storage")), usage: v.optional(languageModelUsage) }),
);

export const stepStatus = v.union(
  v.object({ kind: v.literal("running") }),
  v.object({ kind: v.literal("passed"), durationMs: v.number() }),
  v.object({ kind: v.literal("failed"), failureReason: v.string(), durationMs: v.number() }),
  v.object({ kind: v.literal("skipped") }),
);

// Experiment name type - "default" for runs without an experiment tag
const experimentName = v.union(v.literal("default"), experimentLiteral);

export default defineSchema({
  // Denormalized experiment stats - updated when runs/evals are created/completed
  experiments: defineTable({
    name: experimentName,
    runCount: v.number(),
    completedRuns: v.number(),
    totalEvals: v.number(),
    passedEvals: v.number(),
    // Store models as an array since Set isn't supported
    models: v.array(v.string()),
    latestRunTime: v.number(),
  })
    .index("by_name", ["name"]),

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
    // Display name for UI (e.g., "Claude 4.5 Opus")
    formattedName: v.string(),
    provider: v.string(),
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

  // Materialised leaderboard scores per (model, experiment) pair.
  // Updated via a scheduled mutation whenever a run completes or is deleted.
  // The leaderboardScores query reads directly from this table instead of
  // recomputing from runs + evals on every request.
  modelScores: defineTable({
    model: v.string(),
    experiment: v.optional(experimentLiteral),
    formattedName: v.string(),
    totalScore: v.number(),
    totalScoreErrorBar: v.number(),
    averageRunCostUsd: v.union(v.number(), v.null()),
    averageRunCostUsdErrorBar: v.union(v.number(), v.null()),
    scores: v.record(v.string(), v.number()),
    scoreErrorBars: v.record(v.string(), v.number()),
    runCount: v.number(),
    latestRunId: v.id("runs"),
    latestRunTime: v.number(),
  })
    .index("by_model_experiment", ["model", "experiment"])
    .index("by_experiment", ["experiment"]),
});
