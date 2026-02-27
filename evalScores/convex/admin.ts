/**
 * Public admin mutations/queries for the eval runner.
 *
 * Each function takes a `token` argument that is validated against the
 * `authTokens` table before proceeding. This replaces the old HTTP
 * endpoint layer with direct Convex client calls.
 */
import { mutation, type MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { experimentLiteral, languageModelUsage, stepNameLiteral, stepStatus } from "./schema.js";

// ── Helper ───────────────────────────────────────────────────────────

async function assertValidToken(
  ctx: MutationCtx,
  token: string,
): Promise<void> {
  const valid = await ctx.runMutation(internal.auth.validateToken, {
    value: token,
  });
  if (!valid) {
    throw new Error("Invalid authentication token");
  }
}

// ── Run lifecycle ────────────────────────────────────────────────────

export const startRun = mutation({
  args: {
    token: v.string(),
    model: v.string(),
    formattedName: v.string(),
    provider: v.string(),
    runId: v.optional(v.string()),
    plannedEvals: v.array(v.string()),
    experiment: v.optional(experimentLiteral),
  },
  returns: v.id("runs"),
  handler: async (ctx, args): Promise<Id<"runs">> => {
    await assertValidToken(ctx, args.token);
    const { token: _, ...rest } = args;
    return await ctx.runMutation(internal.runs.createRun, rest);
  },
});

export const completeRun = mutation({
  args: {
    token: v.string(),
    runId: v.id("runs"),
    status: v.union(
      v.object({ kind: v.literal("completed"), durationMs: v.number(), usage: v.optional(languageModelUsage) }),
      v.object({
        kind: v.literal("failed"),
        failureReason: v.string(),
        durationMs: v.number(),
        usage: v.optional(languageModelUsage),
      }),
    ),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    await assertValidToken(ctx, args.token);
    await ctx.runMutation(internal.runs.completeRun, {
      runId: args.runId,
      status: args.status,
    });
    return null;
  },
});

export const deleteRun = mutation({
  args: {
    token: v.string(),
    runId: v.id("runs"),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    await assertValidToken(ctx, args.token);
    await ctx.runMutation(internal.runs.deleteRun, {
      runId: args.runId,
    });
    return null;
  },
});

// ── Eval lifecycle ───────────────────────────────────────────────────

export const startEval = mutation({
  args: {
    token: v.string(),
    runId: v.id("runs"),
    evalPath: v.string(),
    category: v.string(),
    name: v.string(),
    task: v.optional(v.string()),
    evalSourceStorageId: v.optional(v.id("_storage")),
  },
  returns: v.id("evals"),
  handler: async (ctx, args): Promise<Id<"evals">> => {
    await assertValidToken(ctx, args.token);
    const { token: _, ...rest } = args;
    return await ctx.runMutation(internal.evals.createEval, rest);
  },
});

export const recordStep = mutation({
  args: {
    token: v.string(),
    evalId: v.id("evals"),
    name: stepNameLiteral,
    status: stepStatus,
  },
  returns: v.id("steps"),
  handler: async (ctx, args): Promise<Id<"steps">> => {
    await assertValidToken(ctx, args.token);
    return await ctx.runMutation(internal.steps.recordStep, {
      evalId: args.evalId,
      name: args.name,
      status: args.status,
    });
  },
});

export const updateEvalOutput = mutation({
  args: {
    token: v.string(),
    evalId: v.id("evals"),
    outputStorageId: v.id("_storage"),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    await assertValidToken(ctx, args.token);
    await ctx.runMutation(internal.evals.updateEvalOutput, {
      evalId: args.evalId,
      outputStorageId: args.outputStorageId,
    });
    return null;
  },
});

export const completeEval = mutation({
  args: {
    token: v.string(),
    evalId: v.id("evals"),
    status: v.union(
      v.object({
        kind: v.literal("passed"),
        durationMs: v.number(),
        outputStorageId: v.optional(v.id("_storage")),
        usage: v.optional(languageModelUsage),
      }),
      v.object({
        kind: v.literal("failed"),
        failureReason: v.string(),
        durationMs: v.number(),
        outputStorageId: v.optional(v.id("_storage")),
        usage: v.optional(languageModelUsage),
      }),
    ),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    await assertValidToken(ctx, args.token);
    await ctx.runMutation(internal.evals.completeEval, {
      evalId: args.evalId,
      status: args.status,
    });
    return null;
  },
});

export const seedMissingEvalCosts = mutation({
  args: {
    token: v.string(),
    runId: v.optional(v.id("runs")),
  },
  returns: v.object({
    scanned: v.number(),
    updated: v.number(),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{ scanned: number; updated: number }> => {
    await assertValidToken(ctx, args.token);
    return await ctx.runMutation(internal.evals.seedMissingEvalCosts, {
      runId: args.runId,
    });
  },
});

// ── Asset deduplication ──────────────────────────────────────────────

export const checkAssetHash = mutation({
  args: {
    token: v.string(),
    hash: v.string(),
  },
  returns: v.object({
    exists: v.boolean(),
    storageId: v.union(v.id("_storage"), v.null()),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{ exists: boolean; storageId: Id<"_storage"> | null }> => {
    await assertValidToken(ctx, args.token);
    const existing = await ctx.runQuery(internal.evalAssets.getByHash, {
      hash: args.hash,
    });
    if (existing) {
      return { exists: true, storageId: existing.storageId };
    }
    return { exists: false, storageId: null };
  },
});

export const registerAsset = mutation({
  args: {
    token: v.string(),
    hash: v.string(),
    assetType: v.union(v.literal("evalSource"), v.literal("output")),
    storageId: v.id("_storage"),
  },
  returns: v.id("evalAssets"),
  handler: async (ctx, args): Promise<Id<"evalAssets">> => {
    await assertValidToken(ctx, args.token);
    return await ctx.runMutation(internal.evalAssets.create, {
      hash: args.hash,
      assetType: args.assetType,
      storageId: args.storageId,
    });
  },
});

// ── Storage ──────────────────────────────────────────────────────────

export const generateUploadUrl = mutation({
  args: {
    token: v.string(),
  },
  returns: v.string(),
  handler: async (ctx, args): Promise<string> => {
    await assertValidToken(ctx, args.token);
    return await ctx.storage.generateUploadUrl();
  },
});
