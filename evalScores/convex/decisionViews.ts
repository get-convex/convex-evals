import {
  paginationOptsValidator,
  paginationResultValidator,
} from "convex/server";
import { v } from "convex/values";
import { query, type QueryCtx } from "./_generated/server.js";
import {
  findBenchmarkByKind,
  listBenchmarksByKind,
  latestBenchmarkByKind,
  requireCodingBenchmark,
  requireDecisionBenchmark,
  decisionCodingEvalCount,
  type DecisionBenchmark,
} from "./benchmarkKinds.js";
import { decisionCondition, decisionProfile } from "./schema.js";
import {
  requireDecisionRun,
  requireDecisionModelScore,
  requireDecisionResult,
  type DecisionRun,
} from "./documentKinds.js";

const sharedVersionValidator = v.object({
  version: v.string(),
  effectiveAt: v.number(),
  codingEvalCount: v.number(),
  decisionSourceCount: v.number(),
  decisionQuestionCount: v.number(),
  decisionAvailable: v.boolean(),
});
const publicOriginValidator = v.union(
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
);
const publicSummaryValidator = v.object({
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
  estimatedCostUsd: v.optional(v.number()),
  medianDurationMs: v.union(v.number(), v.null()),
  p95DurationMs: v.union(v.number(), v.null()),
});
const publicRunFields = {
  kind: v.literal("decision"),
  _id: v.id("runs"),
  _creationTime: v.number(),
  benchmarkVersion: v.string(),
  model: v.string(),
  formattedName: v.string(),
  condition: decisionCondition,
  profile: decisionProfile,
  profileHash: v.string(),
  fullSuite: v.boolean(),
  plannedQuestionCount: v.number(),
  plannedSourceCount: v.number(),
  status: v.union(
    v.literal("running"),
    v.literal("completed"),
    v.literal("interrupted"),
  ),
  leaderboardEligible: v.boolean(),
  origin: publicOriginValidator,
  finishedAt: v.union(v.number(), v.null()),
  durationMs: v.union(v.number(), v.null()),
  failureReason: v.union(v.string(), v.null()),
  summary: v.union(publicSummaryValidator, v.null()),
};
const publicRunValidator = v.object(publicRunFields);
const publicScoreValidator = v.object({
  kind: v.literal("decision"),
  _id: v.id("modelScores"),
  model: v.string(),
  formattedName: v.string(),
  condition: decisionCondition,
  benchmarkVersion: v.string(),
  profileHash: v.string(),
  profile: decisionProfile,
  score: v.number(),
  scoreStdDev: v.number(),
  categoryScores: v.record(v.string(), v.number()),
  runCount: v.number(),
  plannedQuestions: v.number(),
  invalidResponses: v.number(),
  providerErrors: v.number(),
  validResponses: v.number(),
  decisionSourceCount: v.number(),
  decisionQuestionCount: v.number(),
  averageRunDurationMs: v.number(),
  medianQuestionDurationMs: v.union(v.number(), v.null()),
  p95QuestionDurationMs: v.union(v.number(), v.null()),
  averageKnownRunCostUsd: v.number(),
  completeCostRunCount: v.number(),
  averageRunCostUsd: v.union(v.number(), v.null()),
  estimatedAverageRunCostUsd: v.optional(v.number()),
  latestRunId: v.id("runs"),
  latestRunTime: v.number(),
});
const publicResultValidator = v.object({
  kind: v.literal("decision"),
  _id: v.id("evals"),
  questionKey: v.string(),
  sourceEval: v.string(),
  questionId: v.string(),
  repetition: v.number(),
  outcome: v.union(
    v.literal("answered"),
    v.literal("invalid_response"),
    v.literal("provider_error"),
  ),
  selectedCanonicalId: v.union(v.string(), v.null()),
  expectedCanonicalId: v.string(),
  correct: v.boolean(),
  returnedModel: v.union(v.string(), v.null()),
  durationMs: v.number(),
  requestAttempts: v.number(),
  costUsd: v.union(v.number(), v.null()),
  knownCostUsd: v.number(),
  evidenceSha256: v.string(),
  evidenceUrl: v.union(v.string(), v.null()),
});

type SharedVersionView = {
  version: string;
  effectiveAt: number;
  codingEvalCount: number;
  decisionSourceCount: number;
  decisionQuestionCount: number;
  decisionAvailable: boolean;
};

function sharedVersion(
  benchmark: DecisionBenchmark,
  codingEvalCount: number,
): SharedVersionView {
  const decision = benchmark.decision;
  return {
    version: benchmark.version,
    effectiveAt: benchmark.effectiveAt,
    codingEvalCount,
    decisionSourceCount: decision?.sources.length ?? 0,
    decisionQuestionCount:
      decision?.sources.reduce(
        (total, source) => total + source.questions.length,
        0,
      ) ?? 0,
    decisionAvailable: decision !== undefined,
  };
}

const MAX_DECISION_PAGE_SIZE = 100;

function boundedPagination<T extends { numItems: number }>(options: T): T {
  return {
    ...options,
    numItems: Math.min(
      Math.max(Math.trunc(options.numItems), 1),
      MAX_DECISION_PAGE_SIZE,
    ),
  };
}

async function formattedNames(
  ctx: QueryCtx,
  slugs: Iterable<string>,
): Promise<Map<string, string>> {
  const uniqueSlugs = [...new Set(slugs)];
  const entries = await Promise.all(
    uniqueSlugs.map(async (slug) => {
      const model = await ctx.db
        .query("models")
        .withIndex("by_slug", (q) => q.eq("slug", slug))
        .unique();
      return [slug, model?.formattedName ?? slug] as const;
    }),
  );
  return new Map(entries);
}

function plannedSourceCount(run: DecisionRun): number {
  return new Set(
    run.plannedQuestions.map((key) => key.slice(0, key.lastIndexOf("/"))),
  ).size;
}

function decisionRunView(
  run: DecisionRun,
  benchmarkVersion: string,
  modelName: string,
): {
  kind: "decision";
  _id: DecisionRun["_id"];
  _creationTime: number;
  benchmarkVersion: string;
  model: string;
  formattedName: string;
  condition: DecisionRun["condition"];
  profile: DecisionRun["profile"];
  profileHash: string;
  fullSuite: boolean;
  plannedQuestionCount: number;
  plannedSourceCount: number;
  status: DecisionRun["status"];
  leaderboardEligible: boolean;
  origin: DecisionRun["origin"];
  finishedAt: number | null;
  durationMs: number | null;
  failureReason: string | null;
  summary: NonNullable<DecisionRun["summary"]> | null;
} {
  return {
    kind: "decision" as const,
    _id: run._id,
    _creationTime: run._creationTime,
    benchmarkVersion,
    model: run.model,
    formattedName: modelName,
    condition: run.condition,
    profile: run.profile,
    profileHash: run.profileHash,
    fullSuite: run.fullSuite,
    plannedQuestionCount: run.plannedQuestions.length * run.profile.repetitions,
    plannedSourceCount: plannedSourceCount(run),
    status: run.status,
    leaderboardEligible: run.status === "completed" && run.fullSuite,
    origin: run.origin,
    finishedAt: run.finishedAt ?? null,
    durationMs: run.durationMs ?? null,
    failureReason: run.failureReason ?? null,
    summary: run.summary ?? null,
  };
}

export const decisionLeaderboard = query({
  args: {
    benchmarkVersion: v.optional(v.string()),
    condition: decisionCondition,
    paginationOpts: paginationOptsValidator,
  },
  returns: v.object({
    availability: v.union(v.literal("ready"), v.literal("not_available")),
    benchmark: v.union(sharedVersionValidator, v.null()),
    results: paginationResultValidator(publicScoreValidator),
  }),
  handler: async (ctx, args) => {
    const benchmark = args.benchmarkVersion
      ? await findBenchmarkByKind(ctx, "decision", args.benchmarkVersion)
      : await latestBenchmarkByKind(ctx, "decision");
    if (!benchmark) {
      return {
        availability: "not_available" as const,
        benchmark: null,
        results: { page: [], isDone: true, continueCursor: "" },
      };
    }
    const page = await ctx.db
      .query("modelScores")
      .withIndex("by_kind_benchmark_condition_score", (q) =>
        q
          .eq("kind", "decision")
          .eq("benchmarkVersion", benchmark._id)
          .eq("condition", args.condition),
      )
      .order("desc")
      .paginate(boundedPagination(args.paginationOpts));
    const scores = page.page.map(requireDecisionModelScore);
    const uniqueLatestRunIds = [
      ...new Set(scores.map((score) => score.latestRunId)),
    ];
    const latestRunEntries = await Promise.all(
      uniqueLatestRunIds.map(async (runId) => {
        const stored = await ctx.db.get("runs", runId);
        if (!stored) throw new Error(`Missing latest decision run ${runId}`);
        return [runId, requireDecisionRun(stored)] as const;
      }),
    );
    const latestRuns = new Map(latestRunEntries);
    const names = await formattedNames(
      ctx,
      scores.map((score) => score.model),
    );
    const questionCount = benchmark.decision.sources.reduce(
      (total, source) => total + source.questions.length,
      0,
    );
    const results = scores.map((score) => {
      const latest = latestRuns.get(score.latestRunId)!;
      return {
        kind: "decision" as const,
        _id: score._id,
        model: score.model,
        formattedName: names.get(score.model)!,
        condition: score.condition,
        benchmarkVersion: benchmark.version,
        profileHash: score.profileHash,
        profile: latest.profile,
        score: score.score,
        scoreStdDev: score.scoreStdDev,
        categoryScores: score.categoryScores,
        runCount: score.runCount,
        plannedQuestions: score.plannedQuestions,
        invalidResponses: score.invalidResponses,
        providerErrors: score.providerErrors,
        validResponses:
          score.plannedQuestions -
          score.invalidResponses -
          score.providerErrors,
        decisionSourceCount: benchmark.decision.sources.length,
        decisionQuestionCount: questionCount,
        averageRunDurationMs: score.averageRunDurationMs,
        medianQuestionDurationMs: score.medianQuestionDurationMs,
        p95QuestionDurationMs: score.p95QuestionDurationMs,
        averageKnownRunCostUsd: score.averageKnownRunCostUsd,
        completeCostRunCount: score.completeCostRunCount,
        averageRunCostUsd: score.averageRunCostUsd,
        ...(score.estimatedAverageRunCostUsd !== undefined
          ? { estimatedAverageRunCostUsd: score.estimatedAverageRunCostUsd }
          : {}),
        latestRunId: score.latestRunId,
        latestRunTime: score.latestRunTime,
      };
    });
    return {
      availability: "ready" as const,
      benchmark: sharedVersion(
        benchmark,
        await decisionCodingEvalCount(ctx, benchmark),
      ),
      results: { ...page, page: results },
    };
  },
});

export const listDecisionRuns = query({
  args: {
    benchmarkVersion: v.string(),
    condition: decisionCondition,
    model: v.optional(v.string()),
    profileHash: v.optional(v.string()),
    paginationOpts: paginationOptsValidator,
  },
  returns: paginationResultValidator(publicRunValidator),
  handler: async (ctx, args) => {
    const benchmark = await findBenchmarkByKind(
      ctx,
      "decision",
      args.benchmarkVersion,
    );
    if (!benchmark) return { page: [], isDone: true, continueCursor: "" };
    const requestedModel = args.model;
    const requestedProfile = args.profileHash;
    const paginationOpts = boundedPagination(args.paginationOpts);
    const page =
      requestedModel && requestedProfile
        ? await ctx.db
            .query("runs")
            .withIndex("by_kind_cohort", (q) =>
              q
                .eq("kind", "decision")
                .eq("benchmarkVersion", benchmark._id)
                .eq("condition", args.condition)
                .eq("model", requestedModel)
                .eq("profileHash", requestedProfile),
            )
            .order("desc")
            .paginate(paginationOpts)
        : requestedModel
          ? await ctx.db
              .query("runs")
              .withIndex("by_kind_cohort", (q) =>
                q
                  .eq("kind", "decision")
                  .eq("benchmarkVersion", benchmark._id)
                  .eq("condition", args.condition)
                  .eq("model", requestedModel),
              )
              .order("desc")
              .paginate(paginationOpts)
          : await ctx.db
              .query("runs")
              .withIndex("by_kind_benchmark_condition", (q) =>
                q
                  .eq("kind", "decision")
                  .eq("benchmarkVersion", benchmark._id)
                  .eq("condition", args.condition),
              )
              .order("desc")
              .filter((q) =>
                requestedProfile
                  ? q.eq(q.field("profileHash"), requestedProfile)
                  : true,
              )
              .paginate(paginationOpts);
    const runs = page.page.map(requireDecisionRun);
    const names = await formattedNames(
      ctx,
      runs.map((run) => run.model),
    );
    return {
      ...page,
      page: runs.map((run) =>
        decisionRunView(run, benchmark.version, names.get(run.model)!),
      ),
    };
  },
});

export const getDecisionRun = query({
  args: { runId: v.id("runs") },
  returns: v.union(
    v.object({
      ...publicRunFields,
      benchmark: sharedVersionValidator,
      plannedQuestions: v.array(v.string()),
      sourceEvidenceSha256: v.string(),
      sourceEvidenceUrl: v.union(v.string(), v.null()),
      runEvidenceSha256: v.union(v.string(), v.null()),
      runEvidenceUrl: v.union(v.string(), v.null()),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const stored = await ctx.db.get("runs", args.runId);
    if (!stored) return null;
    const run = requireDecisionRun(stored);
    const storedBenchmark = await ctx.db.get(
      "benchmarkVersions",
      run.benchmarkVersion,
    );
    const benchmark = storedBenchmark
      ? requireDecisionBenchmark(storedBenchmark)
      : null;
    if (!benchmark) return null;
    const names = await formattedNames(ctx, [run.model]);
    return {
      ...decisionRunView(run, benchmark.version, names.get(run.model)!),
      benchmark: sharedVersion(
        benchmark,
        await decisionCodingEvalCount(ctx, benchmark),
      ),
      plannedQuestions: run.plannedQuestions,
      sourceEvidenceSha256: benchmark.decision.sourceEvidence.sha256,
      sourceEvidenceUrl: await ctx.storage.getUrl(
        benchmark.decision.sourceEvidence.storageId,
      ),
      runEvidenceSha256: run.evidence?.sha256 ?? null,
      runEvidenceUrl: run.evidence
        ? await ctx.storage.getUrl(run.evidence.storageId)
        : null,
    };
  },
});

export const decisionResults = query({
  args: { runId: v.id("runs"), paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(publicResultValidator),
  handler: async (ctx, args) => {
    const stored = await ctx.db.get("runs", args.runId);
    if (!stored) return { page: [], isDone: true, continueCursor: "" };
    const run = requireDecisionRun(stored);
    const storedBenchmark = await ctx.db.get(
      "benchmarkVersions",
      run.benchmarkVersion,
    );
    const benchmark = storedBenchmark
      ? requireDecisionBenchmark(storedBenchmark)
      : null;
    if (!benchmark) return { page: [], isDone: true, continueCursor: "" };
    const answers = new Map<string, string>(
      benchmark.decision.sources.flatMap((source) =>
        source.questions.map(
          (question) =>
            [
              `${source.evalPath}/${question.id}`,
              question.correctOptionId,
            ] as const,
        ),
      ),
    );
    const page = await ctx.db
      .query("evals")
      .withIndex("by_kind_run_question_repetition", (q) =>
        q.eq("kind", "decision").eq("runId", run._id),
      )
      .paginate(boundedPagination(args.paginationOpts));
    return {
      ...page,
      page: await Promise.all(
        page.page.map(async (storedResult) => {
          const result = requireDecisionResult(storedResult);
          const slash = result.questionKey.lastIndexOf("/");
          return {
            kind: "decision" as const,
            _id: result._id,
            questionKey: result.questionKey,
            sourceEval: result.questionKey.slice(0, slash),
            questionId: result.questionKey.slice(slash + 1),
            repetition: result.repetition,
            outcome: result.outcome,
            selectedCanonicalId: result.selectedCanonicalId,
            expectedCanonicalId: answers.get(result.questionKey)!,
            correct: result.correct,
            returnedModel: result.returnedModel,
            durationMs: result.durationMs,
            requestAttempts: result.requestAttempts,
            costUsd: result.costUsd,
            knownCostUsd: result.knownCostUsd,
            evidenceSha256: result.evidence.sha256,
            evidenceUrl: await ctx.storage.getUrl(result.evidence.storageId),
          };
        }),
      ),
    };
  },
});

/** Decision selectors must never source their versions from the coding leaderboard. */
export const decisionLeaderboardVersions = query({
  args: {},
  returns: v.array(
    v.object({ ...sharedVersionValidator.fields, isCurrent: v.boolean() }),
  ),
  handler: async (ctx) => {
    const benchmarks = await listBenchmarksByKind(ctx, "decision");
    // Several decision releases can refer to the same coding suite. Cache this
    // small metadata join per request rather than fetching it for every version.
    const coverage = new Map<string, number>();
    const versions = [];
    for (const [index, benchmark] of benchmarks.entries()) {
      const link = benchmark.codingBenchmarkVersion;
      if (link && !coverage.has(link)) {
        const coding = await ctx.db.get("benchmarkVersions", link);
        if (!coding)
          throw new Error("Decision benchmark has a missing coding source");
        coverage.set(link, requireCodingBenchmark(coding).evalCount);
      }
      const view = sharedVersion(benchmark, coverage.get(link)!);
      versions.push({ ...view, isCurrent: index === 0 });
    }
    return versions;
  },
});
