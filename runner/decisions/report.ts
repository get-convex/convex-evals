import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { ProviderAttempt } from "./providers.js";
import { questionBankSchema } from "./questions.js";
import {
  summarizeResults,
  type PlannedQuestion,
  type QuestionResult,
} from "./scoring.js";

const benchmarkSchema = z.object({
  version: z.string(),
  evalCount: z.number(),
});
const plannedQuestionSchema = z.object({
  key: z.string(),
  sourceEval: z.string(),
  repetition: z.number(),
  question: questionBankSchema.shape.questions.element,
  presented: z.object({
    input: z.object({
      context: z.string(),
      question: z.string(),
      options: z.record(z.string(), z.string()),
    }),
    displayToCanonical: z.record(z.string(), z.string()),
    expectedDisplayId: z.string(),
  }),
});
const manifestSchema = z.looseObject({
  artifactVersion: z.literal(1),
  createdAt: z.string(),
  scope: z.enum(["local-only", "github-actions", "development"]),
  benchmarkStatus: z.enum(["minted", "unminted"]),
  benchmark: benchmarkSchema,
  config: z.object({
    provider: z.enum(["typesafe", "openrouter"]),
    model: z.string(),
    reasoningEffort: z.enum(["low", "medium", "high"]),
    maxOutputTokens: z.number(),
    timeoutMs: z.number(),
    maxRetries: z.number(),
  }),
  condition: z.enum(["no_guidelines", "with_guidelines"]),
  seed: z.string(),
  repetitions: z.number(),
  fullSuite: z.boolean(),
  maxRequests: z.number(),
  maxKnownCostUsd: z.number(),
  sourceFingerprints: z.record(z.string(), z.string()),
  planned: z.array(plannedQuestionSchema),
  provenance: z
    .looseObject({
      operation: z.literal("offline-regrade"),
      reason: z.string(),
      sourceBenchmark: benchmarkSchema,
      reclassifiedResults: z.array(z.unknown()),
    })
    .optional(),
});
const providerAttemptSchema = z.object({
  attempt: z.number(),
  startedAt: z.string(),
  durationMs: z.number(),
  httpStatus: z.number().nullable(),
  response: z.unknown(),
  error: z.string().nullable(),
});
const resultSchema = z.object({
  key: z.string(),
  sourceEval: z.string(),
  repetition: z.number(),
  kind: z.enum(["answered", "invalid_response", "provider_error"]),
  correct: z.boolean(),
  selectedCanonicalId: z.string().nullable(),
  expectedCanonicalId: z.string(),
  outcome: z.object({
    kind: z.enum(["answered", "invalid_response", "provider_error"]),
    answer: z
      .object({
        choice: z.string(),
        probabilities: z.record(z.string(), z.number()).nullable(),
        confidence: z.number().nullable(),
        returnedModel: z.string().nullable(),
        usage: z.record(z.string(), z.unknown()).nullable(),
        costUsd: z.number().nullable(),
      })
      .nullable(),
    error: z.string().nullable(),
    attempts: z.array(providerAttemptSchema),
    durationMs: z.number(),
  }),
});
const attemptRecordSchema = providerAttemptSchema.extend({
  key: z.string(),
  request: z.record(z.string(), z.unknown()),
});

// Saved artifacts are an input boundary. Keep additional manifest metadata for
// immutable regrade provenance, but validate every field the readers consume.
export function parseDecisionManifest(
  text: string,
): z.infer<typeof manifestSchema> {
  return manifestSchema.parse(JSON.parse(text));
}
export function parseQuestionResults(text: string): QuestionResult[] {
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => resultSchema.parse(JSON.parse(line)));
}
export type DecisionAttemptRecord = ProviderAttempt & {
  key: string;
  request: Record<string, unknown>;
};
export function parseAttemptRecords(text: string): DecisionAttemptRecord[] {
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => attemptRecordSchema.parse(JSON.parse(line)));
}

/** Completed rows replace their start rows, rather than counting as another
 * request. A start without a completion may have incurred provider cost, so it
 * remains an unknown-cost attempt. Legacy artifacts have no start journal. */
export function reconcileAttemptJournal(
  planned: ReadonlyArray<Pick<PlannedQuestion, "key">>,
  completed: readonly DecisionAttemptRecord[],
  starts?: readonly DecisionAttemptRecord[],
): DecisionAttemptRecord[] {
  const expected = new Set(planned.map((item) => item.key));
  if (expected.size !== planned.length)
    throw new Error("Duplicate planned question IDs");
  const identity = (record: DecisionAttemptRecord): string =>
    JSON.stringify([record.key, record.attempt]);
  const index = (
    records: readonly DecisionAttemptRecord[],
    name: string,
  ): Map<string, DecisionAttemptRecord> => {
    const rows = new Map<string, DecisionAttemptRecord>();
    for (const record of records) {
      if (!expected.has(record.key))
        throw new Error(`Unplanned ${name} attempt: ${record.key}`);
      if (!Number.isSafeInteger(record.attempt) || record.attempt < 1)
        throw new Error(`Invalid attempt ID: ${record.key}/${record.attempt}`);
      const id = identity(record);
      if (rows.has(id))
        throw new Error(
          `Duplicate ${name} attempt: ${record.key}/${record.attempt}`,
        );
      rows.set(id, record);
    }
    return rows;
  };
  const completions = index(completed, "completed");
  const beginnings =
    starts === undefined ? undefined : index(starts, "started");
  const journal = beginnings ?? completions;
  const attemptsByKey = new Map<string, number[]>();
  for (const record of journal.values()) {
    const ids = attemptsByKey.get(record.key) ?? [];
    ids.push(record.attempt);
    attemptsByKey.set(record.key, ids);
  }
  for (const [key, ids] of attemptsByKey) {
    if (ids.sort((a, b) => a - b).some((id, position) => id !== position + 1))
      throw new Error(`Nonsequential attempt journal: ${key}`);
  }
  if (!beginnings) return [...completions.values()];
  for (const [id, completion] of completions) {
    const start = beginnings.get(id);
    if (!start)
      throw new Error(
        `Completed attempt has no matching start: ${completion.key}/${completion.attempt}`,
      );
    if (
      start.startedAt !== completion.startedAt ||
      !isDeepStrictEqual(start.request, completion.request)
    )
      throw new Error(
        `Attempt start/completion mismatch: ${completion.key}/${completion.attempt}`,
      );
  }
  return [...beginnings].map(
    ([id, start]) =>
      completions.get(id) ?? {
        ...start,
        durationMs: 0,
        httpStatus: null,
        response: null,
        error: "Request started but its outcome was not recorded",
      },
  );
}

const escape = (value: unknown): string =>
  String(value).replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );
const percent = (value: number): string => `${(value * 100).toFixed(1)}%`;

export function writeReport(
  directory: string,
): ReturnType<typeof summarizeResults> {
  const manifest = parseDecisionManifest(
    readFileSync(join(directory, "manifest.json"), "utf8"),
  );
  const planned: PlannedQuestion[] = manifest.planned;
  const results = parseQuestionResults(
    readFileSync(join(directory, "results.jsonl"), "utf8"),
  );
  // Recompute from saved outcomes, rather than trusting a persisted correctness flag.
  for (const result of results) {
    const item = planned.find((entry) => entry.key === result.key);
    if (!item) throw new Error(`Unplanned result: ${result.key}`);
    const selected = result.outcome.answer
      ? (item.presented.displayToCanonical[result.outcome.answer.choice] ??
        null)
      : null;
    result.selectedCanonicalId = selected;
    result.expectedCanonicalId = item.question.correctOptionId;
    result.kind = result.outcome.kind;
    result.correct =
      result.kind === "answered" && selected === item.question.correctOptionId;
  }
  // A request may have finished without a question row, or started without a
  // saved response. Preserve both cases without treating unknown spend as zero.
  const completedAttempts = parseAttemptRecords(
    readFileSync(join(directory, "attempts.jsonl"), "utf8"),
  );
  const startsPath = join(directory, "attempt-starts.jsonl");
  const starts = existsSync(startsPath)
    ? parseAttemptRecords(readFileSync(startsPath, "utf8"))
    : undefined;
  const attempts = reconcileAttemptJournal(planned, completedAttempts, starts);
  const summary = summarizeResults(planned, results, attempts);
  writeFileSync(
    join(directory, "summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  const byKey = new Map(results.map((result) => [result.key, result]));
  const categories = Object.entries(summary.categoryScores)
    .map(
      ([category, score]) =>
        `<tr><td>${escape(category)}</td><td>${percent(score)}</td></tr>`,
    )
    .join("");
  const items = planned
    .map((item) => {
      const result = byKey.get(item.key);
      const status = !result
        ? "Not attempted"
        : result.kind !== "answered"
          ? result.kind
          : result.correct
            ? "Correct"
            : "Incorrect";
      const options = Object.entries(item.presented.input.options)
        .map(([label, text]) => {
          const canonical = item.presented.displayToCanonical[label];
          const original = item.question.options.find(
            (option) => option.id === canonical,
          )!;
          return `<li><strong>${escape(label)}${canonical === item.question.correctOptionId ? " · Answer key" : ""}${canonical === result?.selectedCanonicalId ? " · Selected" : ""}</strong><pre>${escape(text)}</pre><p>${escape(original.rationale)}</p></li>`;
        })
        .join("");
      return `<details><summary>${escape(status)} · ${escape(item.sourceEval)} · ${escape(item.question.id)} · repeat ${item.repetition + 1}</summary><p>${escape(item.question.concept)}</p><pre>${escape(item.question.context)}</pre><h3>${escape(item.question.question)}</h3><ol>${options}</ol><p>${escape(result?.outcome.error ?? "")}</p><pre>${escape(JSON.stringify(result?.outcome.answer ?? null, null, 2))}</pre></details>`;
    })
    .join("");
  const provenance =
    manifest.provenance?.operation === "offline-regrade"
      ? `<p><strong>Offline regrade:</strong> ${escape(manifest.provenance.reason)}. Original inference benchmark: ${escape(manifest.provenance.sourceBenchmark.version)}. ${manifest.provenance.reclassifiedResults.length} outcome(s) reclassified; no new API requests.</p>`
      : "";
  const scopeLabel =
    manifest.scope === "github-actions"
      ? "GitHub Actions run"
      : manifest.scope === "development"
        ? "Development run"
        : "Local run";
  const publicationNote =
    manifest.scope === "local-only"
      ? "This local trial is not a published benchmark."
      : manifest.scope === "development"
        ? "Development results do not appear on the production leaderboard."
        : "This report records a GitHub Actions run; leaderboard publication depends on successful ingestion and full-suite eligibility.";
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Convex multiple-choice results</title><style>body{font:16px/1.55 system-ui,sans-serif;background:#f5f5f3;color:#222;max-width:1040px;margin:40px auto;padding:0 24px}h1{font-size:30px}h2{margin-top:30px}table{border-collapse:collapse;width:100%;background:white}td,th{padding:10px 16px;border-bottom:1px solid #ddd;text-align:left}details{background:white;border:1px solid #ddd;border-radius:8px;margin:12px 0;padding:14px}summary{cursor:pointer;font-weight:600}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f0f1f2;padding:12px;border-radius:5px;font-size:13px}li{margin-bottom:20px}.facts{display:flex;gap:24px;flex-wrap:wrap}.facts p{background:white;border:1px solid #ddd;border-radius:8px;padding:14px}small{color:#555}h3{font-size:17px}</style><h1>Convex multiple-choice results</h1><p>${escape(manifest.config.provider)} / ${escape(manifest.config.model)} · ${escape(manifest.condition)} · ${summary.complete ? "Completed" : "Incomplete"} ${manifest.fullSuite ? "full-bank run" : "pilot"}</p><small>${scopeLabel}; ${escape(manifest.benchmarkStatus)} benchmark ${escape(manifest.benchmark.version)}. Multiple-choice knowledge scores are separate from coding scores. Random-choice baseline: 25%.</small>${provenance}<div class="facts"><p><strong>${percent(summary.score)}</strong><br>Mean source-eval score</p><p><strong>${summary.correctQuestions}/${summary.plannedQuestions}</strong><br>Questions correct</p><p><strong>${summary.completedQuestions}/${summary.plannedQuestions}</strong><br>Questions attempted</p><p><strong>${summary.costComplete ? "$" + summary.costUsd!.toFixed(6) : "Unknown total"}</strong><br>Provider-reported cost</p></div><p>Median ${summary.medianDurationMs?.toFixed(0) ?? "?"} ms; p95 ${summary.p95DurationMs?.toFixed(0) ?? "?"} ms. Invalid responses: ${summary.invalidResponses}; provider failures: ${summary.providerErrors}. Cost includes known attempts; missing usage is not zero. ${publicationNote}</p><h2>Categories</h2><table><thead><tr><th>Category</th><th>Score</th></tr></thead><tbody>${categories}</tbody></table><h2>Questions and evidence</h2>${items}</html>`;
  writeFileSync(join(directory, "report.html"), html);
  return summary;
}
