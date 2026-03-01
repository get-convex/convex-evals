/**
 * Database migrations for the evalScores backend.
 *
 * Run all migrations after deploying:
 *   cd evalScores && npx convex run migrations:runAll --prod
 *
 * Monitor progress:
 *   npx convex run --component migrations lib:getStatus --watch --prod
 */
import { Migrations } from "@convex-dev/migrations";
import { components, internal } from "./_generated/api.js";
import type { DataModel } from "./_generated/dataModel.js";

export const migrations = new Migrations<DataModel>(components.migrations);

// ── Static model lookup tables ───────────────────────────────────────
// Hardcoded from runner/models/index.ts so the migration can run inside
// the Convex backend (which doesn't have access to runner code).

const MODEL_FORMATTED_NAMES: Record<string, string> = {
  "claude-3-5-sonnet-latest": "Claude 3.5 Sonnet",
  "claude-3-7-sonnet-latest": "Claude 3.7 Sonnet",
  "claude-sonnet-4-0": "Claude 4 Sonnet",
  "claude-sonnet-4-5": "Claude 4.5 Sonnet",
  "claude-haiku-4-5": "Claude 4.5 Haiku",
  "claude-opus-4-5": "Claude 4.5 Opus",
  "claude-opus-4-6": "Claude 4.6 Opus",
  "o4-mini": "o4-mini",
  "gpt-4.1": "GPT-4.1",
  "gpt-5.1": "GPT-5.1",
  "gpt-5.2": "GPT-5.2",
  "gpt-5.2-codex": "GPT-5.2 Codex",
  "gpt-5": "GPT-5",
  "gpt-5-mini": "GPT-5 mini",
  "gpt-5-nano": "GPT-5 nano",
  "deepseek-ai/DeepSeek-V3": "DeepSeek V3",
  "deepseek-ai/DeepSeek-R1": "DeepSeek R1",
  "meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8": "Llama 4 Maverick",
  "zai-org/GLM-4.7": "GLM 4.7",
  "kimi-k2-0905-preview": "Kimi K2",
  "kimi-k2.5": "Kimi K2.5",
  "Qwen/Qwen3-235B-A22B-Instruct-2507-tput": "Qwen3 235B",
  "gemini-2.5-flash": "Gemini 2.5 Flash",
  "gemini-2.5-pro": "Gemini 2.5 Pro",
  "gemini-3-pro-preview": "Gemini 3 Pro",
  "grok-4": "Grok 4",
  "grok-3-mini-beta": "Grok 3 Mini (Beta)",
  // Legacy models that may exist in older runs
  "gpt-4o": "GPT-4o",
  "o3-mini": "o3-mini",
  "gemini-2.0-flash-lite": "Gemini 2.0 Flash Lite",
  "meta-llama/Meta-Llama-3.1-405B-Instruct-Turbo": "Llama 3.1 405B",
  // OpenRouter model names (post-migration)
  "anthropic/claude-3.5-sonnet": "Claude 3.5 Sonnet",
  "anthropic/claude-3.7-sonnet": "Claude 3.7 Sonnet",
  "anthropic/claude-sonnet-4": "Claude 4 Sonnet",
  "anthropic/claude-sonnet-4.5": "Claude 4.5 Sonnet",
  "anthropic/claude-haiku-4.5": "Claude 4.5 Haiku",
  "anthropic/claude-opus-4.5": "Claude 4.5 Opus",
  "anthropic/claude-opus-4.6": "Claude 4.6 Opus",
  "openai/o4-mini": "o4-mini",
  "openai/gpt-4.1": "GPT-4.1",
  "openai/gpt-5.1": "GPT-5.1",
  "openai/gpt-5.2": "GPT-5.2",
  "openai/gpt-5": "GPT-5",
  "openai/gpt-5.2-codex": "GPT-5.2 Codex",
  "openai/gpt-5-mini": "GPT-5 mini",
  "openai/gpt-5-nano": "GPT-5 nano",
  "deepseek/deepseek-chat-v3": "DeepSeek V3",
  "deepseek/deepseek-r1": "DeepSeek R1",
  "meta-llama/llama-4-maverick": "Llama 4 Maverick",
  "qwen/qwen3-235b-a22b": "Qwen3 235B",
  "z-ai/glm-5": "GLM 5",
  "z-ai/glm-4.7": "GLM 4.7",
  "moonshotai/kimi-k2-0905": "Kimi K2",
  "moonshotai/kimi-k2.5": "Kimi K2.5",
  "google/gemini-2.5-flash": "Gemini 2.5 Flash",
  "google/gemini-2.5-pro": "Gemini 2.5 Pro",
  "google/gemini-3-pro-preview": "Gemini 3 Pro",
  "x-ai/grok-4": "Grok 4",
  "x-ai/grok-3-mini-beta": "Grok 3 Mini (Beta)",
};

const MODEL_PROVIDERS: Record<string, string> = {
  "claude-3-5-sonnet-latest": "anthropic",
  "claude-3-7-sonnet-latest": "anthropic",
  "claude-sonnet-4-0": "anthropic",
  "claude-sonnet-4-5": "anthropic",
  "claude-haiku-4-5": "anthropic",
  "claude-opus-4-5": "anthropic",
  "claude-opus-4-6": "anthropic",
  "o4-mini": "openai",
  "gpt-4.1": "openai",
  "gpt-5.1": "openai",
  "gpt-5.2": "openai",
  "gpt-5.2-codex": "openai",
  "gpt-5": "openai",
  "gpt-5-mini": "openai",
  "gpt-5-nano": "openai",
  "deepseek-ai/DeepSeek-V3": "together",
  "deepseek-ai/DeepSeek-R1": "together",
  "meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8": "together",
  "zai-org/GLM-4.7": "together",
  "kimi-k2-0905-preview": "moonshot",
  "kimi-k2.5": "moonshot",
  "Qwen/Qwen3-235B-A22B-Instruct-2507-tput": "together",
  "gemini-2.5-flash": "google",
  "gemini-2.5-pro": "google",
  "gemini-3-pro-preview": "google",
  "grok-4": "xai",
  "grok-3-mini-beta": "xai",
  // Legacy models
  "gpt-4o": "openai",
  "o3-mini": "openai",
  "gemini-2.0-flash-lite": "google",
  "meta-llama/Meta-Llama-3.1-405B-Instruct-Turbo": "together",
  // OpenRouter model names (post-migration)
  "anthropic/claude-3.5-sonnet": "openrouter",
  "anthropic/claude-3.7-sonnet": "openrouter",
  "anthropic/claude-sonnet-4": "openrouter",
  "anthropic/claude-sonnet-4.5": "openrouter",
  "anthropic/claude-haiku-4.5": "openrouter",
  "anthropic/claude-opus-4.5": "openrouter",
  "anthropic/claude-opus-4.6": "openrouter",
  "openai/o4-mini": "openrouter",
  "openai/gpt-4.1": "openrouter",
  "openai/gpt-5.1": "openrouter",
  "openai/gpt-5.2": "openrouter",
  "openai/gpt-5": "openrouter",
  "openai/gpt-5.2-codex": "openrouter",
  "openai/gpt-5-mini": "openrouter",
  "openai/gpt-5-nano": "openrouter",
  "deepseek/deepseek-chat-v3": "openrouter",
  "deepseek/deepseek-r1": "openrouter",
  "meta-llama/llama-4-maverick": "openrouter",
  "qwen/qwen3-235b-a22b": "openrouter",
  "z-ai/glm-5": "openrouter",
  "z-ai/glm-4.7": "openrouter",
  "moonshotai/kimi-k2-0905": "openrouter",
  "moonshotai/kimi-k2.5": "openrouter",
  "google/gemini-2.5-flash": "openrouter",
  "google/gemini-2.5-pro": "openrouter",
  "google/gemini-3-pro-preview": "openrouter",
  "x-ai/grok-4": "openrouter",
  "x-ai/grok-3-mini-beta": "openrouter",
};

/** Old model names -> OpenRouter model IDs for migration */
const OLD_TO_NEW_MODEL_NAMES: Record<string, string> = {
  "claude-3-5-sonnet-latest": "anthropic/claude-3.5-sonnet",
  "claude-3-7-sonnet-latest": "anthropic/claude-3.7-sonnet",
  "claude-sonnet-4-0": "anthropic/claude-sonnet-4",
  "claude-sonnet-4-5": "anthropic/claude-sonnet-4.5",
  "claude-haiku-4-5": "anthropic/claude-haiku-4.5",
  "claude-opus-4-5": "anthropic/claude-opus-4.5",
  "claude-opus-4-6": "anthropic/claude-opus-4.6",
  "o4-mini": "openai/o4-mini",
  "gpt-4.1": "openai/gpt-4.1",
  "gpt-5.1": "openai/gpt-5.1",
  "gpt-5.2": "openai/gpt-5.2",
  "gpt-5": "openai/gpt-5",
  "gpt-5-mini": "openai/gpt-5-mini",
  "gpt-5-nano": "openai/gpt-5-nano",
  "deepseek-ai/DeepSeek-V3": "deepseek/deepseek-chat-v3",
  "deepseek-ai/DeepSeek-R1": "deepseek/deepseek-r1",
  "meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8":
    "meta-llama/llama-4-maverick",
  "Qwen/Qwen3-235B-A22B-Instruct-2507-tput": "qwen/qwen3-235b-a22b",
  "kimi-k2-0905-preview": "moonshotai/kimi-k2-0905",
  "kimi-k2.5": "moonshotai/kimi-k2.5",
  "gemini-2.5-flash": "google/gemini-2.5-flash",
  "gemini-2.5-pro": "google/gemini-2.5-pro",
  "gemini-3-pro-preview": "google/gemini-3-pro-preview",
  "grok-4": "x-ai/grok-4",
  "grok-3-mini-beta": "x-ai/grok-3-mini-beta",
  "gpt-5.2-codex": "openai/gpt-5.2-codex",
  "zai-org/GLM-4.7": "z-ai/glm-4.7",
  // z-ai/glm-5 and z-ai/glm-4.7 already use OpenRouter names
};

// ── Migration definitions ────────────────────────────────────────────

/**
 * Backfill `formattedName` and `provider` on existing runs that are missing them.
 * After this migration completes, these fields can be made required in the schema.
 */
export const backfillRunFields = migrations.define({
  table: "runs",
  migrateOne: async (_ctx, doc) => {
    const updates: Record<string, string> = {};
    if (doc.formattedName === undefined) {
      updates.formattedName = MODEL_FORMATTED_NAMES[doc.model] ?? doc.model;
    }
    if (doc.provider === undefined) {
      updates.provider = MODEL_PROVIDERS[doc.model] ?? "unknown";
    }
    if (Object.keys(updates).length > 0) return updates;
  },
});

/**
 * Fix runs marked as "completed" where not all planned evals actually finished.
 * These are runs that errored out early but were incorrectly marked as completed.
 * After this migration, such runs will be marked as "failed".
 */
export const fixIncompleteCompletedRuns = migrations.define({
  table: "runs",
  migrateOne: async (ctx, doc) => {
    // Only look at runs marked as "completed"
    if (doc.status.kind !== "completed") return;

    const planned = doc.plannedEvals.length;
    if (planned === 0) return;

    // Count evals that have a terminal status (passed or failed)
    const evals = await ctx.db
      .query("evals")
      .withIndex("by_runId", (q) => q.eq("runId", doc._id))
      .collect();
    const finished = evals.filter(
      (e) => e.status.kind === "passed" || e.status.kind === "failed",
    ).length;

    // If not all planned evals finished, mark as failed
    if (finished < planned) {
      return {
        status: {
          kind: "failed" as const,
          failureReason: `Only ${finished}/${planned} evals completed (detected by fixIncompleteCompletedRuns migration)`,
          durationMs: doc.status.durationMs,
        },
      };
    }
  },
});

/**
 * Fix runs with evals stuck in "pending" because the runner's error handler
 * did not call completeEval. This migration handles two cases:
 *
 * 1. Runs marked "failed" by fixIncompleteCompletedRuns — marks pending evals
 *    as failed and restores the run to "completed".
 * 2. Runs still marked "completed" but with pending evals — marks the pending
 *    evals as failed so isFullyCompletedRun returns true.
 */
export const fixPendingEvalsAndRestoreRuns = migrations.define({
  table: "runs",
  migrateOne: async (ctx, doc) => {
    const isMarkedFailedByMigration =
      doc.status.kind === "failed" &&
      doc.status.failureReason?.includes(
        "detected by fixIncompleteCompletedRuns migration",
      );
    const isCompletedWithPossiblePending = doc.status.kind === "completed";

    if (!isMarkedFailedByMigration && !isCompletedWithPossiblePending) return;

    const evals = await ctx.db
      .query("evals")
      .withIndex("by_runId", (q) => q.eq("runId", doc._id))
      .collect();

    // Mark any non-terminal evals as failed
    let fixedCount = 0;
    for (const evalDoc of evals) {
      if (
        evalDoc.status.kind !== "passed" &&
        evalDoc.status.kind !== "failed"
      ) {
        await ctx.db.patch(evalDoc._id, {
          status: {
            kind: "failed" as const,
            failureReason:
              "Eval stuck in pending — runner error handler did not call completeEval",
            durationMs: 0,
          },
        });
        fixedCount++;
      }
    }

    if (fixedCount === 0) return; // nothing to fix

    // For runs marked failed by the earlier migration, restore to "completed"
    // now that all evals are terminal.
    if (
      doc.status.kind === "failed" &&
      doc.status.failureReason?.includes(
        "detected by fixIncompleteCompletedRuns migration",
      )
    ) {
      const planned = doc.plannedEvals.length;
      const finished =
        evals.filter(
          (e) => e.status.kind === "passed" || e.status.kind === "failed",
        ).length + fixedCount;

      if (finished >= planned) {
        return {
          status: {
            kind: "completed" as const,
            durationMs: doc.status.durationMs,
          },
        };
      }
    }
  },
});

/**
 * Migrate runs from old model names to OpenRouter model IDs.
 * Preserves leaderboard continuity by renaming in-place.
 */
export const migrateModelNamesToOpenRouter = migrations.define({
  table: "runs",
  migrateOne: async (_ctx, doc) => {
    const newName = OLD_TO_NEW_MODEL_NAMES[doc.model];
    if (!newName) return;
    return {
      model: newName,
      provider: "openrouter",
    };
  },
});

/**
 * Migrate experiments.models array from old model names to OpenRouter IDs.
 */
export const migrateExperimentModelNames = migrations.define({
  table: "experiments",
  migrateOne: async (_ctx, doc) => {
    let changed = false;
    const newModels = doc.models.map((m) => {
      const newName = OLD_TO_NEW_MODEL_NAMES[m];
      if (newName) {
        changed = true;
        return newName;
      }
      return m;
    });
    if (!changed) return;
    // Dedupe in case multiple old names mapped to same new name
    return { models: [...new Set(newModels)] };
  },
});

// ── Runner functions ─────────────────────────────────────────────────

/** Run a single named migration via CLI: npx convex run migrations:run '{fn: "migrations:backfillRunFields"}' */
export const run = migrations.runner();

/** Run all migrations in order: npx convex run migrations:runAll --prod */
export const runAll = migrations.runner([
  internal.migrations.backfillRunFields,
  internal.migrations.fixIncompleteCompletedRuns,
  internal.migrations.fixPendingEvalsAndRestoreRuns,
  internal.migrations.migrateModelNamesToOpenRouter,
  internal.migrations.migrateExperimentModelNames,
]);
