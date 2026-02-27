import { internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { evalStatus, languageModelUsage } from "./schema.js";

export const createEval = internalMutation({
  args: {
    runId: v.id("runs"),
    evalPath: v.string(),
    category: v.string(),
    name: v.string(),
    task: v.optional(v.string()),
    evalSourceStorageId: v.optional(v.id("_storage")),
  },
  returns: v.id("evals"),
  handler: async (ctx, args) => {
    const id = await ctx.db.insert("evals", {
      runId: args.runId,
      evalPath: args.evalPath,
      category: args.category,
      name: args.name,
      status: { kind: "pending" },
      task: args.task,
      evalSourceStorageId: args.evalSourceStorageId,
    });
    
    // Update experiment total evals count
    const run = await ctx.db.get(args.runId);
    if (run) {
      const expName = run.experiment ?? "default";
      const experiment = await ctx.db
        .query("experiments")
        .withIndex("by_name", (q) => q.eq("name", expName))
        .unique();
      
      if (experiment) {
        await ctx.db.patch(experiment._id, {
          totalEvals: experiment.totalEvals + 1,
        });
      }
    }
    
    return id;
  },
});

export const updateEvalStatus = internalMutation({
  args: {
    evalId: v.id("evals"),
    status: evalStatus,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.patch(args.evalId, {
      status: args.status,
    });
    return null;
  },
});

export const updateEvalOutput = internalMutation({
  args: {
    evalId: v.id("evals"),
    outputStorageId: v.id("_storage"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const evalDoc = await ctx.db.get(args.evalId);
    if (!evalDoc) return null;

    // Only update if the eval is still running
    if (evalDoc.status.kind === "running") {
      await ctx.db.patch(args.evalId, {
        status: { ...evalDoc.status, outputStorageId: args.outputStorageId },
      });
    }
    return null;
  },
});

export const completeEval = internalMutation({
  args: {
    evalId: v.id("evals"),
    status: v.union(
      v.object({ kind: v.literal("passed"), durationMs: v.number(), outputStorageId: v.optional(v.id("_storage")), usage: v.optional(languageModelUsage) }),
      v.object({ kind: v.literal("failed"), failureReason: v.string(), durationMs: v.number(), outputStorageId: v.optional(v.id("_storage")), usage: v.optional(languageModelUsage) }),
    ),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const evalDoc = await ctx.db.get(args.evalId);
    if (!evalDoc) return null;
    
    await ctx.db.patch(args.evalId, {
      status: args.status,
    });
    
    // Update experiment passed evals count if this eval passed
    if (args.status.kind === "passed") {
      const run = await ctx.db.get(evalDoc.runId);
      if (run) {
        const expName = run.experiment ?? "default";
        const experiment = await ctx.db
          .query("experiments")
          .withIndex("by_name", (q) => q.eq("name", expName))
          .unique();
        
        if (experiment) {
          await ctx.db.patch(experiment._id, {
            passedEvals: experiment.passedEvals + 1,
          });
        }
      }
    }
    
    return null;
  },
});

function deterministicCostUsd(model: string, evalPath: string): number {
  // Cheap deterministic hash for stable seed values in dev.
  let hash = 0;
  const key = `${model}:${evalPath}`;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  }
  const modelMultiplier =
    model.includes("opus") ? 2.2 :
      model.includes("gpt-5") ? 1.8 :
        model.includes("gemini") ? 1.2 :
          1.0;
  const base = 0.0025;
  const variance = 0.6 + (hash % 140) / 100; // 0.60 - 1.99
  return Number((base * modelMultiplier * variance).toFixed(6));
}

export const seedMissingEvalCosts = internalMutation({
  args: {
    runId: v.optional(v.id("runs")),
  },
  returns: v.object({
    scanned: v.number(),
    updated: v.number(),
  }),
  handler: async (ctx, args) => {
    const evals = args.runId
      ? await ctx.db
          .query("evals")
          .withIndex("by_runId", (q) => q.eq("runId", args.runId!))
          .collect()
      : await ctx.db.query("evals").collect();

    let scanned = 0;
    let updated = 0;
    const runModelCache = new Map<string, string>();

    for (const evalDoc of evals) {
      const status = evalDoc.status;
      if (status.kind !== "passed" && status.kind !== "failed") continue;
      scanned++;

      const existingCost =
        status.usage &&
        typeof status.usage.raw === "object" &&
        status.usage.raw !== null &&
        "cost" in status.usage.raw &&
        typeof (status.usage.raw as { cost?: unknown }).cost === "number"
          ? (status.usage.raw as { cost: number }).cost
          : undefined;
      if (existingCost !== undefined) continue;

      const runIdStr = String(evalDoc.runId);
      let model = runModelCache.get(runIdStr);
      if (!model) {
        const run = await ctx.db.get(evalDoc.runId);
        model = run?.model ?? "unknown-model";
        runModelCache.set(runIdStr, model);
      }

      const seededCost = deterministicCostUsd(model, evalDoc.evalPath);
      const prevUsage = status.usage ?? {};
      const prevRaw =
        prevUsage.raw && typeof prevUsage.raw === "object"
          ? prevUsage.raw
          : {};
      const usage = {
        ...prevUsage,
        raw: {
          ...prevRaw,
          cost: seededCost,
        },
      };

      await ctx.db.patch(evalDoc._id, {
        status: {
          ...status,
          usage,
        },
      });
      updated++;
    }

    return { scanned, updated };
  },
});
