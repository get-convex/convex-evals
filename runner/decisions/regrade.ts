import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { buildRunPlan } from "./run.js";
import {
  buildProviderRequest,
  parseProviderResponse,
  type ProviderAttempt,
  type ProviderOutcome,
} from "./providers.js";
import { gradeQuestion } from "./scoring.js";
import {
  parseAttemptRecords,
  parseDecisionManifest,
  parseQuestionResults,
  reconcileAttemptJournal,
  writeReport,
} from "./report.js";

const digest = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

/** Reparse recorded responses after a parser fix. Keep inference artifacts
 * immutable, require identical questions and provider payloads, and give the
 * revised grading the current shared benchmark identity. Never makes requests. */
export function regradeRun(
  sourceDirectory: string,
  projectRoot: string,
  outputRoot: string,
  reason: string,
) {
  if (!reason.trim()) throw new Error("A regrade reason is required");
  const source = resolve(sourceDirectory);
  const manifestText = readFileSync(join(source, "manifest.json"), "utf8");
  const attemptsText = readFileSync(join(source, "attempts.jsonl"), "utf8");
  const startsPath = join(source, "attempt-starts.jsonl");
  const startsText = existsSync(startsPath)
    ? readFileSync(startsPath, "utf8")
    : undefined;
  const resultsText = readFileSync(join(source, "results.jsonl"), "utf8");
  const manifest = parseDecisionManifest(manifestText);
  if (manifest.artifactVersion !== 1 || manifest.scope !== "local-only")
    throw new Error("Unsupported source artifact");
  const sourceIds = Object.keys(manifest.sourceFingerprints);
  const escapedIds = sourceIds.map((id) =>
    id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  );
  const plan = buildRunPlan({
    projectRoot,
    outputRoot,
    config: manifest.config,
    condition: manifest.condition,
    filter: `^(${escapedIds.join("|")})$`,
    limitEvals: sourceIds.length,
    repetitions: manifest.repetitions,
    seed: manifest.seed,
    maxRequests: manifest.maxRequests,
    maxKnownCostUsd: manifest.maxKnownCostUsd,
    dryRun: true,
  });
  if (!isDeepStrictEqual(plan.planned, manifest.planned))
    throw new Error(
      "Questions, keys, or presentations changed; cannot regrade as the same inference",
    );
  for (const bank of plan.selected) {
    if (manifest.sourceFingerprints[bank.sourceEval] !== bank.sourceFingerprint)
      throw new Error(`Source eval changed: ${bank.sourceEval}`);
  }
  const plannedByKey = new Map(plan.planned.map((item) => [item.key, item]));
  const attemptsByKey = new Map<string, ProviderAttempt[]>();
  const completedAttempts = parseAttemptRecords(attemptsText);
  // Validate the journal before creating a regrade directory. Unfinished starts
  // remain evidence of unknown cost, never synthetic responses to regrade.
  reconcileAttemptJournal(
    plan.planned,
    completedAttempts,
    startsText === undefined ? undefined : parseAttemptRecords(startsText),
  );
  for (const record of completedAttempts) {
    const item = plannedByKey.get(record.key);
    if (!item) throw new Error(`Unplanned attempt: ${record.key}`);
    if (
      !isDeepStrictEqual(
        record.request,
        buildProviderRequest(manifest.config, item.presented, plan.guidelines),
      )
    )
      throw new Error(`Provider payload changed: ${record.key}`);
    const { key, request: _request, ...attempt } = record;
    const recorded = attemptsByKey.get(key) ?? [];
    if (attempt.attempt !== recorded.length + 1)
      throw new Error(`Nonsequential attempt journal: ${key}`);
    recorded.push(attempt);
    attemptsByKey.set(key, recorded);
  }
  const seen = new Set<string>();
  const reclassifiedResults: Array<{
    key: string;
    originalKind: string;
    originalError: string | null;
    currentKind: string;
    currentError: string | null;
    originalCorrect: boolean;
    currentCorrect: boolean;
  }> = [];
  const results = parseQuestionResults(resultsText).map((old) => {
    const item = plannedByKey.get(old.key);
    if (!item || seen.has(old.key))
      throw new Error(`Unplanned or duplicate result: ${old.key}`);
    seen.add(old.key);
    const attempts = attemptsByKey.get(old.key) ?? [];
    if (!attempts.length)
      throw new Error(`Missing attempt evidence: ${old.key}`);
    const last = attempts.at(-1)!;
    const outcome: ProviderOutcome = { ...old.outcome, answer: null, attempts };
    if (
      old.outcome.kind !== "provider_error" &&
      last.httpStatus !== null &&
      last.httpStatus >= 200 &&
      last.httpStatus < 300 &&
      !last.error
    ) {
      try {
        outcome.answer = parseProviderResponse(
          manifest.config,
          last.response,
          Object.keys(item.presented.input.options),
        );
        outcome.kind = "answered";
        outcome.error = null;
      } catch (error) {
        outcome.kind = "invalid_response";
        outcome.error = error instanceof Error ? error.message : String(error);
      }
    } else {
      outcome.kind = "provider_error";
      outcome.error =
        old.outcome.error ?? last.error ?? "Recorded provider failure";
    }
    const graded = gradeQuestion(item, outcome);
    if (
      graded.kind !== old.kind ||
      graded.correct !== old.correct ||
      outcome.error !== old.outcome.error
    ) {
      reclassifiedResults.push({
        key: old.key,
        originalKind: old.kind,
        originalError: old.outcome.error,
        currentKind: graded.kind,
        currentError: outcome.error,
        originalCorrect: old.correct,
        currentCorrect: graded.correct,
      });
    }
    return graded;
  });
  const directory = join(
    resolve(outputRoot),
    `regraded-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`,
  );
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const provenance = {
    operation: "offline-regrade",
    reason,
    sourceDirectory: source,
    sourceBenchmark: manifest.benchmark,
    inferenceCreatedAt: manifest.createdAt,
    sourceManifestSha256: digest(manifestText),
    sourceAttemptsSha256: digest(attemptsText),
    ...(startsText === undefined
      ? {}
      : { sourceAttemptStartsSha256: digest(startsText) }),
    sourceResultsSha256: digest(resultsText),
    networkRequests: 0,
    reclassifiedResults,
  };
  writeFileSync(
    join(directory, "manifest.json"),
    JSON.stringify(
      {
        ...manifest,
        createdAt: new Date().toISOString(),
        benchmark: plan.benchmark,
        provenance,
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
  writeFileSync(join(directory, "attempts.jsonl"), attemptsText, {
    mode: 0o600,
  });
  if (startsText !== undefined)
    writeFileSync(join(directory, "attempt-starts.jsonl"), startsText, {
      mode: 0o600,
    });
  writeFileSync(
    join(directory, "results.jsonl"),
    results.map((item) => JSON.stringify(item)).join("\n") + "\n",
    { mode: 0o600 },
  );
  const summary = writeReport(directory);
  writeFileSync(
    join(directory, "status.json"),
    JSON.stringify(
      {
        kind: summary.complete ? "completed" : "incomplete",
        provenance,
        requests: summary.requestAttempts,
        knownCostUsd: summary.knownCostUsd,
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
  return { directory, summary, provenance };
}
