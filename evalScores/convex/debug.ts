/**
 * Internal action for debugging eval runs.
 *
 * Fetches an eval's full details (steps, task, failure reason) and
 * unzips the model output so you can inspect generated files without
 * going through the web UI.
 *
 * Usage (from the evalScores/ directory):
 *   npx convex run debug:getEvalDebugInfo '{"evalId": "<eval_id>"}'
 *
 * For production:
 *   npx convex run --url https://fabulous-panther-525.convex.cloud debug:getEvalDebugInfo '{"evalId": "<eval_id>"}'
 */
import { internalAction } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { CodingEval, CodingRun } from "./documentKinds.js";
import JSZip from "jszip";

// Text file extensions we'll extract content for
const TEXT_EXTENSIONS = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "json",
  "md",
  "txt",
  "html",
  "css",
  "yaml",
  "yml",
  "toml",
  "env",
  "log",
  "gitignore",
  "npmrc",
]);

function isTextFile(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return TEXT_EXTENSIONS.has(ext);
}

async function extractZipFiles(blob: Blob): Promise<Record<string, string>> {
  const arrayBuffer = await blob.arrayBuffer();
  const zip = await JSZip.loadAsync(arrayBuffer);
  const files: Record<string, string> = {};

  for (const [path, zipEntry] of Object.entries(zip.files)) {
    if (zipEntry.dir) continue;
    if (isTextFile(path)) {
      files[path] = await zipEntry.async("string");
    } else {
      files[path] = "<binary file>";
    }
  }

  return files;
}

type DebugResult = {
  error?: string;
  eval?: {
    _id: Id<"evals">;
    evalPath: string;
    category: string;
    name: string;
    status: CodingEval["status"];
    task: string | null;
  };
  run?: {
    _id: Id<"runs">;
    model: string;
    provider: string | null;
    runId: string | null;
    experiment: string;
    status: CodingRun["status"];
  } | null;
  steps?: Array<{
    name: Doc<"steps">["name"];
    status: Doc<"steps">["status"];
  }>;
  outputFiles?: Record<string, string> | null;
  evalSourceFiles?: Record<string, string> | null;
};

export const getEvalDebugInfo = internalAction({
  args: {
    evalId: v.id("evals"),
  },
  handler: async (ctx, args): Promise<DebugResult> => {
    // 1. Fetch the eval record
    const evalDoc: CodingEval | null = await ctx.runQuery(
      internal.debugQueries.getEvalRecord,
      { evalId: args.evalId },
    );
    if (!evalDoc) {
      return { error: `Eval ${args.evalId} not found` };
    }

    // 2. Fetch steps for this eval
    const steps: Doc<"steps">[] = await ctx.runQuery(
      internal.debugQueries.getStepsForEval,
      { evalId: args.evalId },
    );

    // 3. Fetch the run record for context
    const run: CodingRun | null = await ctx.runQuery(
      internal.debugQueries.getRunRecord,
      { runId: evalDoc.runId },
    );
    const modelDoc = run?.modelId
      ? await ctx.runQuery(internal.debugQueries.getModelRecord, {
          modelId: run.modelId,
        })
      : null;

    // 4. Extract output files from the zip if available
    const outputStorageId =
      evalDoc.status.kind === "passed" || evalDoc.status.kind === "failed"
        ? evalDoc.status.outputStorageId
        : evalDoc.status.kind === "running"
          ? evalDoc.status.outputStorageId
          : undefined;

    let outputFiles: Record<string, string> | null = null;
    if (outputStorageId) {
      const blob = await ctx.storage.get(outputStorageId);
      if (blob) {
        outputFiles = await extractZipFiles(blob);
      }
    }

    // 5. Extract eval source files (task, answer, grader) if available
    let evalSourceFiles: Record<string, string> | null = null;
    if (evalDoc.evalSourceStorageId) {
      const blob = await ctx.storage.get(evalDoc.evalSourceStorageId);
      if (blob) {
        evalSourceFiles = await extractZipFiles(blob);
      }
    }

    // 6. Build the debug summary
    return {
      eval: {
        _id: evalDoc._id,
        evalPath: evalDoc.evalPath,
        category: evalDoc.category,
        name: evalDoc.name,
        status: evalDoc.status,
        task: evalDoc.task ?? null,
      },
      run: run
        ? {
            _id: run._id,
            model: modelDoc?.slug ?? "unknown-model",
            provider: run.provider ?? null,
            runId: run.runId ?? null,
            experiment: run.experiment ?? "default",
            status: run.status,
          }
        : null,
      steps: steps.map((s) => ({
        name: s.name,
        status: s.status,
      })),
      outputFiles,
      evalSourceFiles,
    };
  },
});
