import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const experimentLiteral = v.union(
  v.literal("no_guidelines"),
  v.literal("no_guidelines_with_web"),
  // Retired experiments remain valid for historical records.
  v.literal("web_search"),
  v.literal("web_search_no_guidelines"),
  v.literal("agents_md"),
);

export const benchmarkProvenance = v.union(
  v.literal("minted"),
  v.literal("reconstructed"),
  v.literal("unminted"),
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
  inputTokenDetails: v.optional(
    v.object({
      noCacheTokens: v.optional(v.number()),
      cacheReadTokens: v.optional(v.number()),
      cacheWriteTokens: v.optional(v.number()),
    }),
  ),
  outputTokens: v.optional(v.number()),
  outputTokenDetails: v.optional(
    v.object({
      textTokens: v.optional(v.number()),
      reasoningTokens: v.optional(v.number()),
    }),
  ),
  totalTokens: v.optional(v.number()),
  // Deprecated SDK fields, kept for backward compat with stored data
  reasoningTokens: v.optional(v.number()),
  cachedInputTokens: v.optional(v.number()),
  // Unmodified provider response plus runner-collected metadata such as TTFT.
  // Shape varies by provider and may include extra observability fields.
  raw: v.optional(v.any()),
});

export const runStatus = v.union(
  v.object({ kind: v.literal("pending") }),
  v.object({ kind: v.literal("running") }),
  v.object({
    kind: v.literal("completed"),
    durationMs: v.number(),
    usage: v.optional(languageModelUsage),
  }),
  v.object({
    kind: v.literal("failed"),
    failureReason: v.string(),
    durationMs: v.number(),
    usage: v.optional(languageModelUsage),
  }),
);

export const evalStatus = v.union(
  v.object({ kind: v.literal("pending") }),
  v.object({
    kind: v.literal("running"),
    outputStorageId: v.optional(v.id("_storage")),
  }),
  v.object({
    kind: v.literal("passed"),
    durationMs: v.number(),
    generationDurationMs: v.optional(v.number()),
    outputStorageId: v.optional(v.id("_storage")),
    usage: v.optional(languageModelUsage),
  }),
  v.object({
    kind: v.literal("failed"),
    failureReason: v.string(),
    durationMs: v.number(),
    generationDurationMs: v.optional(v.number()),
    outputStorageId: v.optional(v.id("_storage")),
    usage: v.optional(languageModelUsage),
  }),
);

export const stepStatus = v.union(
  v.object({ kind: v.literal("running") }),
  v.object({ kind: v.literal("passed"), durationMs: v.number() }),
  v.object({
    kind: v.literal("failed"),
    failureReason: v.string(),
    durationMs: v.number(),
  }),
  v.object({ kind: v.literal("skipped") }),
);

// Experiment name type - "default" for runs without an experiment tag
const experimentName = v.union(v.literal("default"), experimentLiteral);

export const decisionCondition = v.union(
  v.literal("no_guidelines"),
  v.literal("with_guidelines"),
);
export const decisionEvidence = v.object({
  storageId: v.id("_storage"),
  sha256: v.string(),
});
export const decisionProfile = v.object({
  // Null means the native decision adapter does not send this setting.
  reasoningEffort: v.union(
    v.literal("low"), v.literal("medium"), v.literal("high"), v.null(),
  ),
  maxOutputTokens: v.union(v.number(), v.null()),
  timeoutMs: v.number(),
  maxRetries: v.number(),
  seed: v.string(),
  repetitions: v.number(),
});
export const decisionDefinition = v.object({
  protocolVersion: v.number(),
  sourceCommit: v.string(),
  sourceEvidence: decisionEvidence,
  // This is the accepted bank, not every coding eval. Counts derive from it.
  sources: v.array(v.object({
    evalPath: v.string(),
    questions: v.array(v.object({
      id: v.string(),
      optionIds: v.array(v.string()),
      correctOptionId: v.string(),
    })),
  })),
});
export const decisionSummary = v.object({
  // Scores are fractions in [0, 1]. Sources receive equal weight.
  score: v.number(),
  categoryScores: v.record(v.string(), v.number()),
  repetitionScores: v.array(v.number()),
  completedQuestions: v.number(),
  correctQuestions: v.number(),
  invalidResponses: v.number(),
  providerErrors: v.number(),
  requestAttempts: v.number(),
  costUsd: v.union(v.number(), v.null()),
  knownCostUsd: v.number(),
  medianDurationMs: v.union(v.number(), v.null()),
  p95DurationMs: v.union(v.number(), v.null()),
});

// One top-level union per shared table; each branch owns its required fields.
export const codingRun = v.object({
  kind: v.literal("coding"),
  modelId: v.id("models"),
  provider: v.string(),
  runId: v.optional(v.string()),
  plannedEvals: v.array(v.string()),
  benchmarkVersion: v.id("benchmarkVersions"),
  status: runStatus,
  experiment: v.optional(experimentLiteral),
});

export const decisionRun = v.object({
  kind: v.literal("decision"),
  benchmarkVersion: v.id("benchmarkVersions"),
  // Idempotency key, scoped by reported CI provenance or the dev origin.
  runKey: v.string(),
  model: v.string(),
  condition: decisionCondition,
  profile: decisionProfile,
  profileHash: v.string(),
  // Unique sourceEval/questionId keys; repetitions expand this exact plan.
  plannedQuestions: v.array(v.string()),
  fullSuite: v.boolean(),
  origin: v.union(
    v.object({
      kind: v.literal("github_actions"),
      repository: v.string(),
      workflow: v.string(),
      runId: v.string(),
      runAttempt: v.number(),
      ref: v.string(),
      sourceCommit: v.string(),
    }),
    v.object({
      kind: v.literal("development"),
      sourceCommit: v.union(v.string(), v.null()),
    }),
  ),
  status: v.union(
    v.literal("running"),
    v.literal("completed"),
    v.literal("interrupted"),
  ),
  finishedAt: v.optional(v.number()),
  durationMs: v.optional(v.number()),
  failureReason: v.optional(v.string()),
  summary: v.optional(decisionSummary),
  // Final manifest and orphan-attempt journal; question blobs are referenced.
  evidence: v.optional(decisionEvidence),
});

export const codingEval = v.object({
  kind: v.literal("coding"),
  runId: v.id("runs"),
  evalPath: v.string(),
  category: v.string(),
  name: v.string(),
  status: evalStatus,
  // Task description (from TASK.txt)
  task: v.optional(v.string()),
  // Reference to eval source files (answer dir, grader, etc.)
  evalSourceStorageId: v.optional(v.id("_storage")),
});

export const decisionResult = v.object({
  kind: v.literal("decision"),
  runId: v.id("runs"),
  questionKey: v.string(),
  repetition: v.number(),
  outcome: v.union(
    v.literal("answered"),
    v.literal("invalid_response"),
    v.literal("provider_error"),
  ),
  selectedCanonicalId: v.union(v.string(), v.null()),
  correct: v.boolean(),
  returnedModel: v.union(v.string(), v.null()),
  durationMs: v.number(),
  requestAttempts: v.number(),
  costUsd: v.union(v.number(), v.null()),
  knownCostUsd: v.number(),
  // Immutable sanitized request, response, retries, and provider diagnostics.
  evidence: decisionEvidence,
});

export const codingModelScore = v.object({
  kind: v.literal("coding"),
  modelId: v.id("models"),
  experiment: v.optional(experimentLiteral),
  benchmarkVersion: v.id("benchmarkVersions"),
  totalScore: v.number(),
  totalScoreErrorBar: v.number(),
  averageRunDurationMs: v.number(),
  averageRunDurationMsErrorBar: v.number(),
  averageRunCostUsd: v.union(v.number(), v.null()),
  averageRunCostUsdErrorBar: v.union(v.number(), v.null()),
  webUsage: v.optional(
    v.object({
      evalCount: v.number(),
      reportedSearchEvalCount: v.number(),
      inferredZeroSearchEvalCount: v.number(),
      searchRequests: v.number(),
      reportedFetchEvalCount: v.number(),
      fetchRequests: v.number(),
    }),
  ),
  scores: v.record(v.string(), v.number()),
  scoreErrorBars: v.record(v.string(), v.number()),
  runCount: v.number(),
  latestRunId: v.id("runs"),
  latestRunTime: v.number(),
});

export const decisionModelScore = v.object({
  kind: v.literal("decision"),
  benchmarkVersion: v.id("benchmarkVersions"),
  model: v.string(),
  condition: decisionCondition,
  profileHash: v.string(),
  score: v.number(),
  scoreStdDev: v.number(),
  categoryScores: v.record(v.string(), v.number()),
  runCount: v.number(),
  plannedQuestions: v.number(),
  invalidResponses: v.number(),
  providerErrors: v.number(),
  averageRunDurationMs: v.number(),
  medianQuestionDurationMs: v.union(v.number(), v.null()),
  p95QuestionDurationMs: v.union(v.number(), v.null()),
  averageKnownRunCostUsd: v.number(),
  completeCostRunCount: v.number(),
  // Null if any contributing run has unknown total cost.
  averageRunCostUsd: v.union(v.number(), v.null()),
  latestRunId: v.id("runs"),
  latestRunTime: v.number(),
});

export const codingBenchmark = v.object({
  kind: v.literal("coding"),
  version: v.string(),
  effectiveAt: v.number(),
  evalCount: v.number(),
  curatedModels: v.array(v.string()),
  provenance: benchmarkProvenance,
});
export const decisionBenchmark = v.object({
  kind: v.literal("decision"),
  version: v.string(),
  effectiveAt: v.number(),
  provenance: v.literal("minted"),
  identityFormat: v.union(v.literal("legacy_shared_v4"), v.literal("decision_v1")),
  codingBenchmarkVersion: v.id("benchmarkVersions"),
  decision: decisionDefinition,
});
// Remove this branch only after the exhaustive benchmark-kind audit passes.
export const legacyBenchmark = v.object({
  version: v.string(),
  effectiveAt: v.number(),
  evalCount: v.number(),
  curatedModels: v.array(v.string()),
  provenance: benchmarkProvenance,
  decision: v.optional(decisionDefinition),
});

export default defineSchema({
  models: defineTable({
    slug: v.string(),
    formattedName: v.string(),
    provider: v.string(),
    apiKind: v.union(v.literal("chat"), v.literal("responses")),
    // First-seen timestamp from OpenRouter model metadata (ms since epoch).
    openRouterFirstSeenAt: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
    lastSeenAt: v.number(),
  }).index("by_slug", ["slug"]),

  // Denormalized experiment stats - updated when runs/evals are created/completed
  experiments: defineTable({
    name: experimentName,
    runCount: v.number(),
    completedRuns: v.number(),
    totalEvals: v.number(),
    passedEvals: v.number(),
    // Store models as an array since Set isn't supported
    models: v.array(v.id("models")),
    latestRunTime: v.number(),
  }).index("by_name", ["name"]),

  authTokens: defineTable({
    name: v.string(),
    value: v.string(),
    createdAt: v.number(),
    lastUsed: v.optional(v.number()),
  })
    .index("by_value", ["value"])
    .index("by_name", ["name"]),

  runs: defineTable(v.union(codingRun, decisionRun))
    .index("by_kind", ["kind"])
    .index("by_kind_modelId", ["kind", "modelId"])
    .index("by_kind_experiment", ["kind", "experiment"])
    .index("by_kind_modelId_experiment_benchmark", ["kind", "modelId", "experiment", "benchmarkVersion"])
    .index("by_kind_runKey", ["kind", "runKey"])
    .index("by_kind_benchmark_condition", ["kind", "benchmarkVersion", "condition"])
    .index("by_kind_cohort", ["kind", "benchmarkVersion", "condition", "model", "profileHash"]),

  benchmarkVersions: defineTable(v.union(legacyBenchmark, codingBenchmark, decisionBenchmark))
    .index("by_version", ["version"])
    .index("by_effectiveAt", ["effectiveAt"])
    .index("by_kind_version", ["kind", "version"])
    .index("by_kind_effectiveAt", ["kind", "effectiveAt"]),

  evals: defineTable(v.union(codingEval, decisionResult))
    .index("by_kind", ["kind"])
    .index("by_kind_runId", ["kind", "runId"])
    .index("by_kind_evalPath", ["kind", "evalPath"])
    .index("by_kind_run_question_repetition", ["kind", "runId", "questionKey", "repetition"]),

  // Stores hash -> storageId mapping for deduplication of eval assets
  evalAssets: defineTable({
    // MD5 hash of the content
    hash: v.string(),
    // Type of asset: "evalSource" for eval directory, "output" for model output
    assetType: v.union(v.literal("evalSource"), v.literal("output")),
    // Reference to the stored file
    storageId: v.id("_storage"),
  }).index("by_hash", ["hash"]),

  steps: defineTable({
    evalId: v.id("evals"),
    name: stepNameLiteral,
    status: stepStatus,
  }).index("by_evalId", ["evalId"]),

  // Materialised scores: coding and decision cohorts have separate union branches.
  // Updated via a scheduled mutation whenever a run completes or is deleted.
  // The leaderboardScores query reads directly from this table instead of
  // recomputing from runs + evals on every request. Always select the kind first.
  modelScores: defineTable(v.union(codingModelScore, decisionModelScore))
    .index("by_kind", ["kind"])
    .index("by_kind_modelId_experiment", ["kind", "modelId", "experiment"])
    .index("by_kind_experiment", ["kind", "experiment"])
    .index("by_kind_modelId_experiment_benchmark", ["kind", "modelId", "experiment", "benchmarkVersion"])
    .index("by_kind_experiment_benchmark", ["kind", "experiment", "benchmarkVersion"])
    .index("by_kind_cohort", ["kind", "benchmarkVersion", "condition", "model", "profileHash"])
    .index("by_kind_benchmark_condition_score", ["kind", "benchmarkVersion", "condition", "score"]),
});
