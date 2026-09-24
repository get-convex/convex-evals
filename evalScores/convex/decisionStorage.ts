import { findBenchmarkByKind, requireDecisionBenchmark, decisionCodingEvalCount } from "./benchmarkKinds.js";
import type { Infer } from "convex/values";
import { decisionDefinition } from "./schema.js";
import { v } from "convex/values";
import { internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
} from "./_generated/server.js";
import {
  MAX_DECISION_REPETITIONS,
  MAX_DECISION_RETRIES,
  MAX_DECISION_TIMEOUT_MS,
  MAX_DECISION_OUTPUT_TOKENS,
} from "./decisionConfig.js";
import {
  aggregateDecisionRuns,
  computeDecisionSummary,
} from "./decisionScoring.js";
import {
  requireDecisionRun,
  requireDecisionResult,
  type DecisionResult,
  type DecisionRun,
} from "./documentKinds.js";
import {
  decisionCondition,
  decisionEvidence,
  decisionProfile,
  decisionSummary,
} from "./schema.js";
import { sameJson } from "./decisionIdentity.js";
import { estimateDecisionRunCost } from "./decisionCosts.js";

const decisionOrigin = v.union(
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

const derivedResult = v.object({
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
  evidence: decisionEvidence,
});

function validateProfile(profile: {
  timeoutMs: number;
  maxRetries: number;
  repetitions: number;
  maxOutputTokens: number | null;
  seed: string;
}): void {
  if (
    !Number.isSafeInteger(profile.timeoutMs) ||
    profile.timeoutMs < 1 ||
    profile.timeoutMs > MAX_DECISION_TIMEOUT_MS
  )
    throw new Error("Invalid decision timeout");
  if (
    !Number.isSafeInteger(profile.maxRetries) ||
    profile.maxRetries < 0 ||
    profile.maxRetries > MAX_DECISION_RETRIES
  )
    throw new Error("Invalid decision retry count");
  if (
    !Number.isSafeInteger(profile.repetitions) ||
    profile.repetitions < 1 ||
    profile.repetitions > MAX_DECISION_REPETITIONS
  )
    throw new Error("Invalid decision repetition count");
  if (
    profile.maxOutputTokens !== null &&
    (!Number.isSafeInteger(profile.maxOutputTokens) ||
      profile.maxOutputTokens < 1 ||
      profile.maxOutputTokens > MAX_DECISION_OUTPUT_TOKENS)
  )
    throw new Error("Invalid decision output-token limit");
  if (!profile.seed) throw new Error("Decision seed is required");
}

function acceptedQuestionKeys(
  decision: Infer<typeof decisionDefinition>,
): string[] {
  return decision.sources
    .flatMap((source) =>
      source.questions.map((question) => `${source.evalPath}/${question.id}`),
    )
    .sort();
}

export const getBenchmarkContext = internalQuery({
  args: { benchmarkHash: v.string() },
  handler: async (ctx, args) => {
    const benchmark = await findBenchmarkByKind(ctx, "decision", args.benchmarkHash);
    return benchmark ? { ...benchmark, evalCount: await decisionCodingEvalCount(ctx, benchmark) } : null;
  },
});

export const getDecisionParent = internalQuery({
  args: { runId: v.id("runs") },
  handler: async (ctx, args) => {
    const stored = await ctx.db.get("runs", args.runId);
    if (!stored) throw new Error("Decision run does not exist");
    return requireDecisionRun(stored);
  },
});

export const getDecisionSourceContext = internalQuery({
  args: { runId: v.id("runs") },
  handler: async (ctx, args) => {
    const stored = await ctx.db.get("runs", args.runId);
    if (!stored) throw new Error("Decision run does not exist");
    const run = requireDecisionRun(stored);
    const storedBenchmark = await ctx.db.get("benchmarkVersions", run.benchmarkVersion);
    if (!storedBenchmark) throw new Error("Decision definition is unavailable");
    const normalized = requireDecisionBenchmark(storedBenchmark);
    const benchmark = { ...normalized, evalCount: await decisionCodingEvalCount(ctx, normalized) };
    return { run, benchmark };
  },
});

export const getDecisionFinalizationContext = internalQuery({
  args: { runId: v.id("runs") },
  handler: async (ctx, args) => {
    const stored = await ctx.db.get("runs", args.runId);
    if (!stored) throw new Error("Decision run does not exist");
    const run = requireDecisionRun(stored);
    const storedBenchmark = await ctx.db.get("benchmarkVersions", run.benchmarkVersion);
    if (!storedBenchmark) throw new Error("Decision definition is unavailable");
    const normalized = requireDecisionBenchmark(storedBenchmark);
    const benchmark = { ...normalized, evalCount: await decisionCodingEvalCount(ctx, normalized) };
    const results = await ctx.db
      .query("evals")
      .withIndex("by_kind_runId", (q) =>
        q.eq("kind", "decision").eq("runId", run._id),
      )
      .collect();
    return { run, benchmark, results };
  },
});

export const createDecisionRun = internalMutation({
  args: {
    runKey: v.string(),
    benchmarkHash: v.string(),
    model: v.string(),
    condition: decisionCondition,
    profile: decisionProfile,
    profileHash: v.string(),
    plannedQuestions: v.array(v.string()),
    origin: decisionOrigin,
  },
  handler: async (ctx, args) => {
    validateProfile(args.profile);
    if (!args.model.trim()) throw new Error("Decision model is required");
    if (!args.runKey || !args.profileHash)
      throw new Error("Invalid decision identity");
    const benchmark = await findBenchmarkByKind(ctx, "decision", args.benchmarkHash);
    if (
      !benchmark ||
      benchmark.provenance !== "minted" ||
      !benchmark.decision
    ) {
      throw new Error("Decision benchmark is not minted");
    }
    const planned = [...args.plannedQuestions];
    if (
      planned.length === 0 ||
      new Set(planned).size !== planned.length ||
      !sameJson(planned, [...planned].sort())
    )
      throw new Error("Planned decision questions must be unique and sorted");
    const accepted = acceptedQuestionKeys(benchmark.decision);
    const acceptedSet = new Set(accepted);
    if (planned.some((key) => !acceptedSet.has(key))) {
      throw new Error("Decision plan contains an unknown question");
    }
    const fullSuite = sameJson(planned, accepted);
    const existing = await ctx.db
      .query("runs")
      .withIndex("by_kind_runKey", (q) =>
        q.eq("kind", "decision").eq("runKey", args.runKey),
      )
      .unique();
    const definition = {
      benchmarkVersion: benchmark._id,
      model: args.model,
      condition: args.condition,
      profile: args.profile,
      profileHash: args.profileHash,
      plannedQuestions: planned,
      fullSuite,
      origin: args.origin,
    };
    if (existing) {
      const run = requireDecisionRun(existing);
      const {
        benchmarkVersion,
        model,
        condition,
        profile,
        profileHash,
        plannedQuestions,
        fullSuite: storedFullSuite,
        origin,
      } = run;
      if (
        !sameJson(
          {
            benchmarkVersion,
            model,
            condition,
            profile,
            profileHash,
            plannedQuestions,
            fullSuite: storedFullSuite,
            origin,
          },
          definition,
        )
      ) {
        throw new Error("Decision run key was reused with different inputs");
      }
      return {
        runId: run._id,
        profileHash: run.profileHash,
        fullSuite: run.fullSuite,
      };
    }
    const runId = await ctx.db.insert("runs", {
      kind: "decision",
      runKey: args.runKey,
      ...definition,
      status: "running",
    });
    return { runId, profileHash: args.profileHash, fullSuite };
  },
});

export const recordDecisionResults = internalMutation({
  args: { runId: v.id("runs"), items: v.array(derivedResult) },
  returns: v.object({ inserted: v.number(), unchanged: v.number() }),
  handler: async (ctx, args) => {
    const stored = await ctx.db.get("runs", args.runId);
    if (!stored) throw new Error("Decision run does not exist");
    const run = requireDecisionRun(stored);
    if (run.status !== "running") throw new Error("Decision run is terminal");
    if (args.items.length === 0 || args.items.length > 25) {
      throw new Error("Invalid decision result batch size");
    }
    const batchSlots = new Set<string>();
    let inserted = 0;
    let unchanged = 0;
    for (const item of args.items) {
      const slot = `${item.questionKey}/${item.repetition}`;
      if (batchSlots.has(slot))
        throw new Error("Duplicate result slot in batch");
      batchSlots.add(slot);
      if (
        !run.plannedQuestions.includes(item.questionKey) ||
        !Number.isSafeInteger(item.repetition) ||
        item.repetition < 0 ||
        item.repetition >= run.profile.repetitions
      )
        throw new Error("Result is outside the immutable decision plan");
      if (
        !Number.isFinite(item.durationMs) ||
        item.durationMs < 0 ||
        !Number.isSafeInteger(item.requestAttempts) ||
        item.requestAttempts < 1 ||
        !Number.isFinite(item.knownCostUsd) ||
        item.knownCostUsd < 0 ||
        (item.costUsd !== null &&
          (!Number.isFinite(item.costUsd) || item.costUsd < 0))
      )
        throw new Error("Invalid derived decision metrics");
      const existing = await ctx.db
        .query("evals")
        .withIndex("by_kind_run_question_repetition", (q) =>
          q
            .eq("kind", "decision")
            .eq("runId", run._id)
            .eq("questionKey", item.questionKey)
            .eq("repetition", item.repetition),
        )
        .unique();
      if (existing) {
        const result = requireDecisionResult(existing);
        if (result.evidence.sha256 !== item.evidence.sha256) {
          throw new Error("Conflicting decision result replay");
        }
        unchanged++;
        continue;
      }
      await ctx.db.insert("evals", {
        kind: "decision",
        runId: run._id,
        ...item,
      });
      inserted++;
    }
    return { inserted, unchanged };
  },
});

export const finalizeDecisionRun = internalMutation({
  args: {
    runId: v.id("runs"),
    evidence: decisionEvidence,
    resultEvidence: v.array(
      v.object({
        questionKey: v.string(),
        repetition: v.number(),
        storageId: v.id("_storage"),
        sha256: v.string(),
      }),
    ),
    finishedAt: v.number(),
    durationMs: v.number(),
    failureReason: v.union(v.string(), v.null()),
    orphanAttempts: v.number(),
    orphanKnownCostUsd: v.number(),
    hasUnknownOrphanCost: v.boolean(),
  },
  handler: async (ctx, args) => {
    const stored = await ctx.db.get("runs", args.runId);
    if (!stored) throw new Error("Decision run does not exist");
    const run = requireDecisionRun(stored);
    if (run.status !== "running") {
      if (run.evidence?.sha256 === args.evidence.sha256 && run.summary) {
        return { status: run.status, summary: run.summary };
      }
      throw new Error("Decision finalization conflicts with terminal evidence");
    }
    const results = (
      await ctx.db
        .query("evals")
        .withIndex("by_kind_runId", (q) =>
          q.eq("kind", "decision").eq("runId", run._id),
        )
        .collect()
    ).map(requireDecisionResult);
    const persisted = results
      .map((result) => ({
        questionKey: result.questionKey,
        repetition: result.repetition,
        storageId: result.evidence.storageId,
        sha256: result.evidence.sha256,
      }))
      .sort((a, b) =>
        `${a.questionKey}/${a.repetition}`.localeCompare(
          `${b.questionKey}/${b.repetition}`,
        ),
      );
    const claimed = [...args.resultEvidence].sort((a, b) =>
      `${a.questionKey}/${a.repetition}`.localeCompare(
        `${b.questionKey}/${b.repetition}`,
      ),
    );
    if (!sameJson(persisted, claimed)) {
      throw new Error(
        "Final evidence does not match persisted decision results",
      );
    }
    const summary = computeDecisionSummary(run, results, args);
    const expectedSlots = run.plannedQuestions.length * run.profile.repetitions;
    const status =
      results.length === expectedSlots ? "completed" : "interrupted";
    await ctx.db.patch("runs", run._id, {
      status,
      finishedAt: args.finishedAt,
      durationMs: args.durationMs,
      ...(status === "interrupted"
        ? {
            failureReason:
              args.failureReason ??
              "Decision run did not complete its exact plan",
          }
        : {}),
      summary,
      evidence: args.evidence,
    });
    if (status === "completed" && run.fullSuite) {
      await ctx.scheduler.runAfter(
        0,
        internal.decisionStorage.recomputeDecisionScore,
        {
          benchmarkVersion: run.benchmarkVersion,
          model: run.model,
          condition: run.condition,
          profileHash: run.profileHash,
        },
      );
    }
    return { status, summary };
  },
});

export const recomputeDecisionScore = internalMutation({
  args: {
    benchmarkVersion: v.id("benchmarkVersions"),
    model: v.string(),
    condition: decisionCondition,
    profileHash: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const benchmark = await ctx.db.get(args.benchmarkVersion);
    if (!benchmark) throw new Error("Missing decision benchmark");
    requireDecisionBenchmark(benchmark);
    const runs = (
      await ctx.db
        .query("runs")
        .withIndex("by_kind_cohort", (q) =>
          q
            .eq("kind", "decision")
            .eq("benchmarkVersion", args.benchmarkVersion)
            .eq("condition", args.condition)
            .eq("model", args.model)
            .eq("profileHash", args.profileHash),
        )
        .order("desc")
        .filter((q) =>
          q.and(
            q.eq(q.field("status"), "completed"),
            q.eq(q.field("fullSuite"), true),
          ),
        )
        .take(10)
    ).map(requireDecisionRun);
    const rows = await Promise.all(
      runs.map(async (run) => ({
        run,
        results: (
          await ctx.db
            .query("evals")
            .withIndex("by_kind_runId", (q) =>
              q.eq("kind", "decision").eq("runId", run._id),
            )
            .collect()
        ).map(requireDecisionResult),
      })),
    );
    const aggregate = aggregateDecisionRuns(rows);
    const existing = await ctx.db
      .query("modelScores")
      .withIndex("by_kind_cohort", (q) =>
        q
          .eq("kind", "decision")
          .eq("benchmarkVersion", args.benchmarkVersion)
          .eq("condition", args.condition)
          .eq("model", args.model)
          .eq("profileHash", args.profileHash),
      )
      .unique();
    if (!aggregate) {
      if (existing) await ctx.db.delete("modelScores", existing._id);
      return null;
    }
    if (existing) await ctx.db.replace(existing._id, aggregate);
    else await ctx.db.insert("modelScores", aggregate);
    return null;
  },
});

/** Repair derived cost metadata without rewriting scores or reported billing.
 * Explicit small batches keep the one-off production backfill bounded. */
export const backfillDecisionCostEstimates = internalMutation({
  args: { runIds: v.array(v.id("runs")) },
  returns: v.object({ updatedRuns: v.number() }),
  handler: async (ctx, { runIds }) => {
    if (runIds.length > 5)
      throw new Error("Backfill at most five decision runs at a time");
    let updatedRuns = 0;
    const cohorts = new Map<
      string,
      {
        benchmarkVersion: Id<"benchmarkVersions">;
        model: string;
        condition: DecisionRun["condition"];
        profileHash: string;
      }
    >();
    for (const runId of new Set(runIds)) {
      const stored = await ctx.db.get("runs", runId);
      if (!stored) continue;
      const run = requireDecisionRun(stored);
      if (run.status !== "completed" || !run.summary) continue;
      const results = (
        await ctx.db
          .query("evals")
          .withIndex("by_kind_runId", (q) =>
            q.eq("kind", "decision").eq("runId", runId),
          )
          .collect()
      ).map(requireDecisionResult);
      const orphanAttempts =
        run.summary.requestAttempts -
        results.reduce((total, result) => total + result.requestAttempts, 0);
      const estimatedCostUsd =
        run.summary.costUsd === null
          ? estimateDecisionRunCost(
              results,
              run.plannedQuestions.length * run.profile.repetitions,
              orphanAttempts,
            )
          : undefined;
      if (run.summary.estimatedCostUsd === estimatedCostUsd) continue;
      const summary = { ...run.summary };
      if (estimatedCostUsd === undefined) delete summary.estimatedCostUsd;
      else summary.estimatedCostUsd = estimatedCostUsd;
      await ctx.db.patch("runs", runId, { summary });
      updatedRuns++;
      const cohort = {
        benchmarkVersion: run.benchmarkVersion,
        model: run.model,
        condition: run.condition,
        profileHash: run.profileHash,
      };
      cohorts.set(JSON.stringify(cohort), cohort);
    }
    for (const cohort of cohorts.values()) {
      await ctx.scheduler.runAfter(
        0,
        internal.decisionStorage.recomputeDecisionScore,
        cohort,
      );
    }
    return { updatedRuns };
  },
});

export async function deleteDecisionRunData(
  ctx: MutationCtx,
  run: DecisionRun,
): Promise<void> {
  const results = (
    await ctx.db
      .query("evals")
      .withIndex("by_kind_runId", (q) =>
        q.eq("kind", "decision").eq("runId", run._id),
      )
      .collect()
  ).map(requireDecisionResult);
  for (const result of results) {
    await ctx.storage.delete(result.evidence.storageId);
    await ctx.db.delete("evals", result._id);
  }
  if (run.evidence) await ctx.storage.delete(run.evidence.storageId);
  await ctx.scheduler.runAfter(
    0,
    internal.decisionStorage.recomputeDecisionScore,
    {
      benchmarkVersion: run.benchmarkVersion,
      model: run.model,
      condition: run.condition,
      profileHash: run.profileHash,
    },
  );
}

export async function interruptDecisionRun(
  ctx: MutationCtx,
  run: DecisionRun,
  now: number,
): Promise<void> {
  if (run.status !== "running") return;
  const results = (
    await ctx.db
      .query("evals")
      .withIndex("by_kind_runId", (q) =>
        q.eq("kind", "decision").eq("runId", run._id),
      )
      .collect()
  ).map(requireDecisionResult);
  const summary = computeDecisionSummary(run, results, {
    orphanAttempts: 0,
    orphanKnownCostUsd: 0,
    // A process can die after dispatch but before persisting its attempt journal.
    // Keep the lower bound while refusing to claim a complete total.
    hasUnknownOrphanCost: true,
  });
  await ctx.db.patch("runs", run._id, {
    status: "interrupted",
    finishedAt: now,
    durationMs: now - run._creationTime,
    failureReason:
      "Decision run was interrupted after exceeding the maintenance timeout",
    summary,
  });
}
