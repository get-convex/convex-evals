import { internalMutation, query } from "./_generated/server";
import { v } from "convex/values";

const experimentLiteral = v.union(v.literal("no_guidelines"));

const runStatus = v.union(
  v.object({ kind: v.literal("pending") }),
  v.object({ kind: v.literal("running") }),
  v.object({ kind: v.literal("completed"), durationMs: v.number() }),
  v.object({ kind: v.literal("failed"), failureReason: v.string(), durationMs: v.number() }),
);

const evalStatus = v.union(
  v.object({ kind: v.literal("pending") }),
  v.object({ kind: v.literal("running") }),
  v.object({ kind: v.literal("passed"), durationMs: v.number() }),
  v.object({ kind: v.literal("failed"), failureReason: v.string(), durationMs: v.number() }),
);

export const createRun = internalMutation({
  args: {
    model: v.string(),
    provider: v.optional(v.string()),
    runId: v.optional(v.string()),
    plannedEvals: v.array(v.string()),
    experiment: v.optional(experimentLiteral),
  },
  returns: v.id("runs"),
  handler: async (ctx, args) => {
    const id = await ctx.db.insert("runs", {
      model: args.model,
      provider: args.provider,
      runId: args.runId,
      plannedEvals: args.plannedEvals,
      status: { kind: "pending" },
      experiment: args.experiment,
    });
    return id;
  },
});

export const updateRunStatus = internalMutation({
  args: {
    runId: v.id("runs"),
    status: runStatus,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch(args.runId, {
      status: args.status,
    });
    return null;
  },
});

export const completeRun = internalMutation({
  args: {
    runId: v.id("runs"),
    status: v.union(
      v.object({ kind: v.literal("completed"), durationMs: v.number() }),
      v.object({ kind: v.literal("failed"), failureReason: v.string(), durationMs: v.number() }),
    ),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch(args.runId, {
      status: args.status,
    });
    return null;
  },
});

export const getRunDetails = query({
  args: {
    runId: v.id("runs"),
  },
  returns: v.union(
    v.object({
      _id: v.id("runs"),
      model: v.string(),
      provider: v.optional(v.string()),
      runId: v.optional(v.string()),
      plannedEvals: v.array(v.string()),
      status: runStatus,
      experiment: v.optional(experimentLiteral),
      _creationTime: v.number(),
      evals: v.array(
        v.object({
          _id: v.id("evals"),
          runId: v.id("runs"),
          evalPath: v.string(),
          category: v.string(),
          name: v.string(),
          status: evalStatus,
          _creationTime: v.number(),
          steps: v.array(
            v.object({
              _id: v.id("steps"),
              evalId: v.id("evals"),
              name: v.union(
                v.literal("filesystem"),
                v.literal("install"),
                v.literal("deploy"),
                v.literal("tsc"),
                v.literal("eslint"),
                v.literal("tests"),
              ),
              status: v.union(
                v.object({ kind: v.literal("running") }),
                v.object({ kind: v.literal("passed"), durationMs: v.number() }),
                v.object({ kind: v.literal("failed"), failureReason: v.string(), durationMs: v.number() }),
                v.object({ kind: v.literal("skipped") }),
              ),
              _creationTime: v.number(),
            }),
          ),
        }),
      ),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run) return null;

    const evals = await ctx.db
      .query("evals")
      .withIndex("by_runId", (q) => q.eq("runId", args.runId))
      .collect();

    const evalsWithSteps = await Promise.all(
      evals.map(async (evalItem) => {
        const steps = await ctx.db
          .query("steps")
          .withIndex("by_evalId", (q) => q.eq("evalId", evalItem._id))
          .collect();
        return {
          ...evalItem,
          steps: steps.map((step) => ({
            _id: step._id,
            evalId: step.evalId,
            name: step.name,
            status: step.status,
            _creationTime: step._creationTime,
          })),
        };
      }),
    );

    return {
      _id: run._id,
      model: run.model,
      provider: run.provider,
      runId: run.runId,
      plannedEvals: run.plannedEvals,
      status: run.status,
      experiment: run.experiment,
      _creationTime: run._creationTime,
      evals: evalsWithSteps,
    };
  },
});
