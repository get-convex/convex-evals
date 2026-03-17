/**
 * Reporting: post results to Convex via ConvexClient.
 */
import {
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  unlinkSync,
} from "fs";
import { join, relative } from "path";
import { tmpdir } from "os";
import { createHash } from "crypto";
import JSZip from "jszip";
import { ConvexClient } from "convex/browser";
import { logInfo } from "./logging.js";
import { api } from "../evalScores/convex/_generated/api.js";
import type { Id } from "../evalScores/convex/_generated/dataModel.js";
import type { LanguageModelUsage } from "ai";

// ── Config ────────────────────────────────────────────────────────────

function isConvexReportingDisabled(): boolean {
  return process.env.DISABLE_CONVEX_REPORTING === "1";
}

function getConvexEvalUrl(): string | undefined {
  if (isConvexReportingDisabled()) return undefined;
  return process.env.CONVEX_EVAL_URL;
}

function getConvexAuthToken(): string | undefined {
  if (isConvexReportingDisabled()) return undefined;
  return process.env.CONVEX_AUTH_TOKEN;
}

function getEvalsExperiment(): string | undefined {
  return process.env.EVALS_EXPERIMENT;
}

/** Cache for eval source hashes to avoid re-uploading. */
const evalSourceCache = new Map<string, string>();

// ── Convex client (lazy-initialized) ─────────────────────────────────

let _client: ConvexClient | null = null;

function getClient(): ConvexClient | null {
  const convexEvalUrl = getConvexEvalUrl();
  if (!convexEvalUrl) return null;
  if (!_client) {
    _client = new ConvexClient(convexEvalUrl);
  }
  return _client;
}

/** Close the Convex client. Call at process shutdown. */
export async function closeClient(): Promise<void> {
  if (_client) {
    await _client.close();
    _client = null;
  }
}

/**
 * Execute a Convex mutation with the auth token.
 * Returns null if the client is not configured.
 */
async function mutate<T>(
  mutation: Parameters<ConvexClient["mutation"]>[0],
  args: Record<string, unknown>,
): Promise<T | null> {
  const client = getClient();
  const convexAuthToken = getConvexAuthToken();
  if (!client || !convexAuthToken) return null;

  return (await client.mutation(mutation, {
    token: convexAuthToken,
    ...args,
  })) as T;
}

/**
 * Execute a Convex mutation, catching and logging errors.
 * Returns null on failure.
 */
async function safeMutate<T>(
  label: string,
  mutation: Parameters<ConvexClient["mutation"]>[0],
  args: Record<string, unknown>,
): Promise<T | null> {
  try {
    const result = await mutate<T>(mutation, args);
    if (result !== null) logInfo(`Successfully called ${label}`);
    return result;
  } catch (e) {
    logInfo(`Error calling ${label}: ${String(e)}`);
    return null;
  }
}

// ── Run lifecycle ─────────────────────────────────────────────────────

export async function startRun(
  modelId: string,
  plannedEvals: string[],
  provider: string,
  experiment?: string,
): Promise<string | null> {
  if (!getClient() || !getConvexAuthToken()) {
    logInfo("Skipping startRun: CONVEX_EVAL_URL or CONVEX_AUTH_TOKEN not set");
    return null;
  }

  return safeMutate<string>("startRun", api.admin.startRun, {
    modelId: modelId as Id<"models">,
    plannedEvals,
    provider,
    experiment: (experiment ?? getEvalsExperiment()) as
      | "no_guidelines"
      | "web_search"
      | "web_search_no_guidelines"
      | undefined,
  });
}

export async function ensureModelFromSlug(
  slug: string,
  formattedName: string,
  provider?: string,
  apiKind?: "chat" | "responses",
  openRouterFirstSeenAt?: number,
): Promise<string | null> {
  if (!getClient() || !getConvexAuthToken()) {
    logInfo(
      "Skipping ensureModelFromSlug: CONVEX_EVAL_URL or CONVEX_AUTH_TOKEN not set",
    );
    return null;
  }

  const result = await safeMutate(
    "ensureModelFromSlug",
    api.admin.ensureModelFromSlug,
    {
      slug,
      formattedName,
      provider,
      apiKind,
      openRouterFirstSeenAt,
    },
  );
  return (result as string | null) ?? null;
}

export async function completeRun(
  runId: string,
  status:
    | { kind: "completed"; durationMs: number; usage?: LanguageModelUsage }
    | { kind: "failed"; failureReason: string; durationMs: number; usage?: LanguageModelUsage },
): Promise<boolean> {
  const result = await safeMutate(
    "completeRun",
    api.admin.completeRun,
    { runId: runId as Id<"runs">, status },
  );
  return result !== null;
}

export async function deleteRunRecord(runId: string): Promise<boolean> {
  const result = await safeMutate("deleteRun", api.admin.deleteRun, {
    runId: runId as Id<"runs">,
  });
  return result !== null;
}

// ── Eval lifecycle ────────────────────────────────────────────────────

export async function startEval(
  runId: string,
  evalPath: string,
  category: string,
  name: string,
  task?: string,
  evalSourceStorageId?: string,
): Promise<string | null> {
  return safeMutate<string>("startEval", api.admin.startEval, {
    runId: runId as Id<"runs">,
    evalPath,
    category,
    name,
    task,
    evalSourceStorageId: evalSourceStorageId as Id<"_storage"> | undefined,
  });
}

type StepName =
  | "filesystem"
  | "install"
  | "deploy"
  | "tsc"
  | "eslint"
  | "tests";
type StepStatus =
  | { kind: "running" }
  | { kind: "passed"; durationMs: number }
  | { kind: "failed"; failureReason: string; durationMs: number }
  | { kind: "skipped" };

export function recordStep(
  evalId: string,
  stepName: StepName,
  status: StepStatus,
): void {
  const client = getClient();
  const convexAuthToken = getConvexAuthToken();
  if (!client || !convexAuthToken) return;

  // Fire and forget - don't block the scorer
  client
    .mutation(api.admin.recordStep, {
      token: convexAuthToken,
      evalId: evalId as Id<"evals">,
      name: stepName,
      status,
    })
    .catch(() => {});
}

/**
 * Upload current output directory and attach to a running eval.
 * Fire-and-forget: errors are logged but don't block the scorer.
 */
export async function uploadEvalOutput(
  evalId: string,
  outputDir: string,
): Promise<void> {
  const client = getClient();
  const convexAuthToken = getConvexAuthToken();
  if (!client || !convexAuthToken) return;

  try {
    const zipPath = await zipDirectory(outputDir, ["node_modules", "_generated"]);
    if (!zipPath) return;
    try {
      const storageId = await uploadToConvexStorage(zipPath);
      if (storageId) {
        await client.mutation(api.admin.updateEvalOutput, {
          token: convexAuthToken,
          evalId: evalId as Id<"evals">,
          outputStorageId: storageId as Id<"_storage">,
        });
      }
    } finally {
      safeUnlink(zipPath);
    }
  } catch {
    // Best-effort: don't block scoring if incremental upload fails
  }
}

type EvalCompleteStatus =
  | {
      kind: "passed";
      durationMs: number;
      outputStorageId?: Id<"_storage">;
      usage?: LanguageModelUsage;
    }
  | {
      kind: "failed";
      failureReason: string;
      durationMs: number;
      outputStorageId?: Id<"_storage">;
      usage?: LanguageModelUsage;
    };

export async function completeEval(
  evalId: string,
  status:
    | { kind: "passed"; durationMs: number; usage?: LanguageModelUsage }
    | { kind: "failed"; failureReason: string; durationMs: number; usage?: LanguageModelUsage },
  outputDir?: string,
): Promise<boolean> {
  let outputStorageId: Id<"_storage"> | undefined;
  if (outputDir) {
    const zipPath = await zipDirectory(outputDir, ["node_modules", "_generated"]);
    if (zipPath) {
      try {
        const sid = await uploadToConvexStorage(zipPath);
        if (sid) outputStorageId = sid as Id<"_storage">;
      } finally {
        safeUnlink(zipPath);
      }
    }
  }

  const fullStatus: EvalCompleteStatus = outputStorageId
    ? { ...status, outputStorageId }
    : status;

  const result = await safeMutate(
    "completeEval",
    api.admin.completeEval,
    { evalId: evalId as Id<"evals">, status: fullStatus },
  );
  return result !== null;
}

// ── Eval source upload with dedup ─────────────────────────────────────

export async function getOrUploadEvalSource(
  evalPath: string,
): Promise<{ taskContent: string | null; storageId: string | null }> {
  if (!getClient() || !getConvexAuthToken()) {
    return { taskContent: null, storageId: null };
  }

  const taskContent = readTaskContent(evalPath);
  const dirHash = computeDirectoryHash(evalPath);

  // Check if already uploaded
  const existing = await checkAssetHash(dirHash);
  if (existing) {
    logInfo(`Eval source already uploaded (hash: ${dirHash.slice(0, 8)}...)`);
    return { taskContent, storageId: existing };
  }

  const zipPath = await zipDirectory(evalPath, [
    "node_modules",
    "_generated",
    "__pycache__",
  ]);
  if (!zipPath) return { taskContent, storageId: null };

  try {
    const storageId = await uploadToConvexStorage(zipPath);
    if (storageId) {
      await registerAsset(dirHash, "evalSource", storageId);
      logInfo(
        `Uploaded and registered eval source (hash: ${dirHash.slice(0, 8)}...)`,
      );
      return { taskContent, storageId };
    }
  } finally {
    safeUnlink(zipPath);
  }
  return { taskContent, storageId: null };
}

// ── Eval result types ─────────────────────────────────────────────────

export interface EvalIndividualResult {
  category: string;
  name: string;
  passed: boolean;
  tests_pass_score: number;
  failure_reason: string | null;
  directory_path: string | null;
  scores: Record<string, number>;
  usage?: LanguageModelUsage;
}

/** Print a console summary after all evals complete. */
export function printEvalSummary(
  modelName: string,
  individualResults: EvalIndividualResult[],
): void {
  const stats = new Map<
    string,
    { count: number; score: number; passed: number }
  >();
  let totalScore = 0;
  let totalTests = 0;
  let totalPassed = 0;

  let runInputTokens = 0;
  let runOutputTokens = 0;

  for (const r of individualResults) {
    const cat = stats.get(r.category) ?? { count: 0, score: 0, passed: 0 };
    cat.count++;
    cat.score += r.tests_pass_score;
    if (r.tests_pass_score >= 1) cat.passed++;
    stats.set(r.category, cat);

    totalTests++;
    totalScore += r.tests_pass_score;
    if (r.tests_pass_score >= 1) totalPassed++;
    
    if (r.usage) {
      runInputTokens += r.usage.inputTokens ?? 0;
      runOutputTokens += r.usage.outputTokens ?? 0;
    }
  }

  const overallRate = totalTests > 0 ? totalScore / totalTests : 0;

  logInfo("");
  logInfo("=== Eval Summary ===");
  logInfo(`Model: ${modelName}`);
  logInfo(
    `Overall: ${(overallRate * 100).toFixed(2)}% (${totalPassed} pass, ${totalTests - totalPassed} fail)`,
  );
  if (runInputTokens > 0 || runOutputTokens > 0) {
    logInfo(`Tokens: ${runInputTokens.toLocaleString()} input, ${runOutputTokens.toLocaleString()} output`);
  }

  for (const [category, cat] of [...stats.entries()].sort()) {
    const rate = cat.count > 0 ? cat.score / cat.count : 0;
    logInfo(
      `- ${category}: ${(rate * 100).toFixed(2)}% (${cat.passed} pass, ${cat.count - cat.passed} fail)`,
    );
  }
}

// ── Upload / zip helpers ──────────────────────────────────────────────

const EXCLUDED_FILE_PREFIXES = [".env", "bun.lock"];

function shouldExcludeFile(filename: string): boolean {
  const lower = filename.toLowerCase();
  return EXCLUDED_FILE_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

async function zipDirectory(
  dir: string,
  excludeDirs: string[],
): Promise<string | null> {
  if (!existsSync(dir)) return null;
  try {
    const files: string[] = [];
    collectFilesForZip(dir, dir, excludeDirs, files);
    if (files.length === 0) return null;

    const zip = new JSZip();
    for (const relPath of files) {
      const fullPath = join(dir, relPath);
      const data = readFileSync(fullPath);
      zip.file(relPath.replace(/\\/g, "/"), data);
    }

    const zipPath = join(
      tmpdir(),
      `convex-evals-${Date.now()}-${Math.random().toString(36).slice(2)}.zip`,
    );
    const content = await zip.generateAsync({ type: "nodebuffer" });
    writeFileSync(zipPath, content);
    return zipPath;
  } catch (e) {
    logInfo(`Error creating zip file: ${String(e)}`);
    return null;
  }
}

function collectFilesForZip(
  baseDir: string,
  currentDir: string,
  excludeDirs: string[],
  files: string[],
): void {
  for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (excludeDirs.includes(entry.name)) continue;
      collectFilesForZip(
        baseDir,
        join(currentDir, entry.name),
        excludeDirs,
        files,
      );
    } else {
      if (shouldExcludeFile(entry.name)) continue;
      files.push(relative(baseDir, join(currentDir, entry.name)));
    }
  }
}

async function uploadToConvexStorage(
  zipPath: string,
): Promise<string | null> {
  const client = getClient();
  const convexAuthToken = getConvexAuthToken();
  if (!client || !convexAuthToken) return null;

  try {
    const uploadUrl: string = await client.mutation(
      api.admin.generateUploadUrl,
      { token: convexAuthToken },
    );

    const fileData = Bun.file(zipPath);
    const resp = await fetch(uploadUrl, {
      method: "POST",
      headers: { "Content-Type": "application/zip" },
      body: fileData,
    });
    if (resp.ok) {
      const json = (await resp.json()) as Record<string, unknown>;
      const storageId = json.storageId as string | undefined;
      if (storageId) {
        logInfo(`Successfully uploaded to Convex storage: ${storageId}`);
        return storageId;
      }
    }
    logInfo(`Failed to upload: HTTP ${resp.status}`);
    return null;
  } catch (e) {
    logInfo(`Error uploading to Convex storage: ${String(e)}`);
    return null;
  }
}

function computeDirectoryHash(
  dirPath: string,
  excludeDirs = ["node_modules", "_generated", "__pycache__"],
): string {
  const hasher = createHash("md5");
  hashDirectory(dirPath, dirPath, excludeDirs, hasher);
  return hasher.digest("hex");
}

function hashDirectory(
  baseDir: string,
  dir: string,
  excludeDirs: string[],
  hasher: ReturnType<typeof createHash>,
): void {
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (excludeDirs.includes(entry.name)) continue;
      hashDirectory(baseDir, join(dir, entry.name), excludeDirs, hasher);
    } else {
      const fullPath = join(dir, entry.name);
      hasher.update(relative(baseDir, fullPath));
      try {
        hasher.update(readFileSync(fullPath));
      } catch {
        /* ignore */
      }
    }
  }
}

async function checkAssetHash(hash: string): Promise<string | null> {
  if (evalSourceCache.has(hash)) return evalSourceCache.get(hash)!;

  try {
    const result = await mutate<{
      exists: boolean;
      storageId?: string;
    }>(api.admin.checkAssetHash, { hash });
    if (result?.exists && typeof result.storageId === "string") {
      evalSourceCache.set(hash, result.storageId);
      return result.storageId;
    }
  } catch (e) {
    logInfo(`Error checking asset hash: ${String(e)}`);
  }
  return null;
}

async function registerAsset(
  hash: string,
  assetType: "evalSource" | "output",
  storageId: string,
): Promise<boolean> {
  const result = await safeMutate(
    "registerAsset",
    api.admin.registerAsset,
    { hash, assetType, storageId: storageId as Id<"_storage"> },
  );
  if (result !== null) evalSourceCache.set(hash, storageId);
  return result !== null;
}

function readTaskContent(evalPath: string): string | null {
  const taskFile = join(evalPath, "TASK.txt");
  if (!existsSync(taskFile)) return null;
  try {
    return readFileSync(taskFile, "utf-8");
  } catch {
    return null;
  }
}

/** Safely delete a file, ignoring errors. */
function safeUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    /* ignore */
  }
}
