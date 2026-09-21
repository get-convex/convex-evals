import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { parse } from "dotenv";
import { computeDecisionBenchmarkDefinition } from "./source.js";
import {
  DECISION_PROTOCOL,
  type ContextCondition,
  type ProviderConfig,
} from "./protocol.js";
import { loadQuestionBanks, presentQuestion } from "./questions.js";
import {
  buildProviderRequest,
  callProvider,
  type ProviderDependencies,
} from "./providers.js";
import {
  gradeQuestion,
  type PlannedQuestion,
  type QuestionResult,
} from "./scoring.js";
import { writeReport } from "./report.js";
import {
  readDecisionDefinition,
  isCompleteDecisionSelection,
} from "./coverage.js";

export interface DecisionRunOptions {
  projectRoot: string;
  outputRoot: string;
  config: ProviderConfig;
  condition: ContextCondition;
  filter?: string;
  limitEvals: number;
  repetitions: number;
  seed: string;
  maxRequests: number;
  maxKnownCostUsd: number;
  envFile?: string;
  dryRun: boolean;
}

export interface DecisionRunMetadata {
  scope: "github-actions" | "development";
  sourceCommit: string;
  runnerLocation: string;
}

/** The local command supplies no hooks. Hosted reporting is opt-in through a
 * separate entry point, and must establish the run before spending on inference. */
export interface DecisionRunHooks {
  metadata: DecisionRunMetadata;
  onStart: (directory: string, manifest: DecisionManifest) => Promise<void>;
  onResult: (
    item: PlannedQuestion,
    request: Record<string, unknown>,
    result: QuestionResult,
  ) => Promise<void>;
  onFinish: (directory: string, durationMs: number) => Promise<void>;
}

export function buildRunPlan(options: DecisionRunOptions) {
  for (const [name, value] of Object.entries({
    limitEvals: options.limitEvals,
    repetitions: options.repetitions,
    maxRequests: options.maxRequests,
    maxOutputTokens: options.config.maxOutputTokens,
    timeoutMs: options.config.timeoutMs,
  })) {
    if (!Number.isSafeInteger(value) || value < 1)
      throw new Error(`${name} must be a positive integer`);
  }
  if (
    !Number.isSafeInteger(options.config.maxRetries) ||
    options.config.maxRetries < 0 ||
    options.config.maxRetries > 3
  )
    throw new Error("maxRetries must be 0–3");
  if (!Number.isFinite(options.maxKnownCostUsd) || options.maxKnownCostUsd <= 0)
    throw new Error("maxKnownCostUsd must be positive");
  if (options.config.timeoutMs > 120_000)
    throw new Error("timeoutMs must not exceed 120000");
  if (!options.config.model.trim()) throw new Error("A model ID is required");
  const root = resolve(options.projectRoot);
  const inventory = loadQuestionBanks(root);
  if (inventory.errors.length)
    throw new Error(`Invalid question bank:\n${inventory.errors.join("\n")}`);
  const coverage = readDecisionDefinition(root, inventory);
  if (coverage.errors.length)
    throw new Error(
      `Invalid decision coverage:\n${coverage.errors.join("\n")}`,
    );
  const filter = options.filter ? new RegExp(options.filter) : null;
  const selected = inventory.banks
    .filter((bank) => !filter || filter.test(bank.sourceEval))
    .slice(0, options.limitEvals);
  if (!selected.length) throw new Error("No question banks matched");
  const planned: PlannedQuestion[] = [];
  for (let repetition = 0; repetition < options.repetitions; repetition++) {
    for (const bank of selected) {
      for (const question of bank.questions) {
        planned.push({
          key: `${bank.sourceEval}/${question.id}/${repetition}`,
          sourceEval: bank.sourceEval,
          repetition,
          question,
          presented: presentQuestion(
            question,
            bank.sourceEval,
            options.seed,
            repetition,
          ),
        });
      }
    }
  }
  if (!options.dryRun && planned.length > options.maxRequests)
    throw new Error(
      `Plan needs ${planned.length} requests before retries, exceeding --max-requests ${options.maxRequests}`,
    );
  const guidelines =
    options.condition === "with_guidelines"
      ? readFileSync(join(root, "runner/models/guidelines.md"), "utf8")
      : "";
  return {
    inventory,
    selected,
    planned,
    guidelines,
    benchmark: computeDecisionBenchmarkDefinition(root),
    decisionDefinition: coverage.definition,
    fullSuite: isCompleteDecisionSelection(coverage.definition, selected),
  };
}

function createManifest(
  options: DecisionRunOptions,
  plan: ReturnType<typeof buildRunPlan>,
  metadata?: DecisionRunMetadata,
) {
  return {
    artifactVersion: 1,
    createdAt: new Date().toISOString(),
    scope: metadata?.scope ?? "local-only",
    benchmarkStatus: metadata ? "minted" : "unminted",
    sourceCommit: metadata?.sourceCommit ?? null,
    benchmark: plan.benchmark,
    format: DECISION_PROTOCOL.format,
    protocol: DECISION_PROTOCOL,
    config: options.config,
    condition: options.condition,
    seed: options.seed,
    repetitions: options.repetitions,
    concurrency: 1,
    runnerLocation: metadata?.runnerLocation ?? "local machine",
    fullSuite: plan.fullSuite,
    decisionDefinition: plan.decisionDefinition,
    sourceEvalCount: plan.inventory.sourceEvalCount,
    availableEvalCount: plan.inventory.banks.length,
    missingEvalIds: plan.inventory.missing,
    maxRequests: options.maxRequests,
    maxKnownCostUsd: options.maxKnownCostUsd,
    sourceFingerprints: Object.fromEntries(
      plan.selected.map((bank) => [bank.sourceEval, bank.sourceFingerprint]),
    ),
    coverageNotes: Object.fromEntries(
      plan.selected.map((bank) => [bank.sourceEval, bank.coverageNotes]),
    ),
    planned: plan.planned,
  };
}

export type DecisionManifest = ReturnType<typeof createManifest>;

/** No reporting imports or credentials: the default local runner stays file-only. */
export async function runDecisions(
  options: DecisionRunOptions,
  dependencies: ProviderDependencies = {},
  hooks?: DecisionRunHooks,
) {
  if (options.dryRun && hooks)
    throw new Error("Dry runs cannot report hosted results");
  // Direct TypeSafe runs remain a local file-only experiment. Hosted ingestion
  // has one route, so reject unsupported providers before start or inference.
  if (hooks && options.config.provider !== "openrouter")
    throw new Error(
      "Hosted decision reporting requires the OpenRouter provider",
    );
  const plan = buildRunPlan(options);
  let key = "";
  if (!options.dryRun) {
    const variable =
      options.config.provider === "typesafe"
        ? "TYPESAFE_API_KEY"
        : "OPENROUTER_API_KEY";
    const fileEnvironment = options.envFile
      ? parse(readFileSync(resolve(options.envFile)))
      : {};
    // Read only the selected provider credential, never the reporting credentials.
    key = process.env[variable] || fileEnvironment[variable] || "";
    if (!key)
      throw new Error(
        `Missing ${variable}; use the environment or --env-file. Never paste keys into commands or reports.`,
      );
  }
  const directory = join(
    resolve(options.outputRoot),
    `${new Date().toISOString().replace(/[:.]/g, "-")}-${options.config.provider}-${randomUUID().slice(0, 8)}`,
  );
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const manifest = createManifest(options, plan, hooks?.metadata);
  writeFileSync(
    join(directory, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mode: 0o600 },
  );
  writeFileSync(join(directory, "attempts.jsonl"), "", { mode: 0o600 });
  writeFileSync(join(directory, "attempt-starts.jsonl"), "", { mode: 0o600 });
  writeFileSync(join(directory, "results.jsonl"), "", { mode: 0o600 });
  if (options.dryRun) {
    const requests = plan.planned.map((item) => ({
      key: item.key,
      request: buildProviderRequest(
        options.config,
        item.presented,
        plan.guidelines,
      ),
    }));
    writeFileSync(
      join(directory, "requests.jsonl"),
      requests.map((request) => JSON.stringify(request)).join("\n") + "\n",
      { mode: 0o600 },
    );
    writeFileSync(
      join(directory, "status.json"),
      JSON.stringify({ kind: "dry_run", networkRequests: 0 }),
    );
    return {
      directory,
      plannedQuestions: plan.planned.length,
      dryRun: true,
      summary: null,
    };
  }
  let attempts = 0;
  let knownSpend = 0;
  let stopReason: string | null = null;
  let consecutiveProviderErrors = 0;
  let reportingFailure: Error | null = null;
  const startedAt = performance.now();
  await hooks?.onStart(directory, manifest);
  try {
    for (const item of plan.planned) {
      const request = buildProviderRequest(
        options.config,
        item.presented,
        plan.guidelines,
      );
      const outcome = await callProvider(options.config, request, key, {
        ...dependencies,
        beforeAttempt: () => {
          if (attempts >= options.maxRequests)
            throw new Error("Request budget reached");
          if (knownSpend >= options.maxKnownCostUsd)
            throw new Error("Known cost limit reached");
          dependencies.beforeAttempt?.();
          attempts++;
        },
        onAttemptStart: (attempt) => {
          appendFileSync(
            join(directory, "attempt-starts.jsonl"),
            JSON.stringify({ key: item.key, request, ...attempt }) + "\n",
          );
          dependencies.onAttemptStart?.(attempt);
        },
        onAttempt: (attempt) => {
          const cost = (
            attempt.response as { usage?: { cost?: unknown } } | null
          )?.usage?.cost;
          if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0)
            knownSpend += cost;
          appendFileSync(
            join(directory, "attempts.jsonl"),
            JSON.stringify({ key: item.key, request, ...attempt }) + "\n",
          );
          dependencies.onAttempt?.(attempt);
        },
      });
      const budgetStop =
        outcome.error === "Request budget reached" ||
        outcome.error === "Known cost limit reached";
      if (budgetStop && outcome.attempts.length === 0) {
        stopReason = outcome.error;
        break;
      }
      const result = gradeQuestion(item, outcome);
      appendFileSync(
        join(directory, "results.jsonl"),
        JSON.stringify(result) + "\n",
      );
      try {
        await hooks?.onResult(item, request, result);
      } catch (error) {
        // Finishing inference is not sufficient if its final result upload fails.
        // Preserve local evidence, then fail the hosted run after finalization.
        reportingFailure =
          error instanceof Error ? error : new Error("Hosted reporting failed");
        throw error;
      }
      console.log(
        `${item.key}: ${outcome.kind === "answered" ? (result.correct ? "correct" : "incorrect") : outcome.kind}`,
      );
      if (budgetStop) {
        stopReason = outcome.error;
        break;
      }
      consecutiveProviderErrors =
        outcome.kind === "provider_error" ? consecutiveProviderErrors + 1 : 0;
      if (
        outcome.attempts.some((attempt) =>
          [401, 402, 403].includes(attempt.httpStatus ?? 0),
        )
      ) {
        stopReason = "Provider authentication, credit, or permission error";
        break;
      }
      if (consecutiveProviderErrors >= 3) {
        stopReason = "Three consecutive provider failures";
        break;
      }
    }
  } catch (error) {
    stopReason = error instanceof Error ? error.message : String(error);
  }
  const summary = writeReport(directory);
  // Attempt accounting stays accurate even if the budget interrupted a retry
  // before a terminal per-question record could be written.
  writeFileSync(
    join(directory, "status.json"),
    JSON.stringify(
      {
        kind:
          summary.complete && !reportingFailure ? "completed" : "incomplete",
        stopReason,
        requests: attempts,
        knownCostUsd: knownSpend,
      },
      null,
      2,
    ) + "\n",
  );
  await hooks?.onFinish(directory, performance.now() - startedAt);
  if (reportingFailure)
    throw new Error(stopReason ?? "Hosted reporting failed", {
      cause: reportingFailure,
    });
  return {
    directory,
    plannedQuestions: plan.planned.length,
    dryRun: false,
    summary,
  };
}
