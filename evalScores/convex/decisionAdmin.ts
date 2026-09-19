"use node";

import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { v } from "convex/values";
import { action, type ActionCtx } from "./_generated/server.js";
import { internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import {
  assertDecisionIngestionEnabled,
  MAX_DECISION_RECORD_BATCH,
  MAX_DECISION_QUESTION_EVIDENCE_BYTES,
  MAX_DECISION_RUN_EVIDENCE_COMPRESSED_BYTES,
  MAX_DECISION_RUN_EVIDENCE_DECOMPRESSED_BYTES,
  MAX_DECISION_SOURCE_EVIDENCE_BYTES,
} from "./decisionConfig.js";
import {
  decisionCondition,
  decisionDefinition,
  decisionEvidence,
  decisionProfile,
} from "./schema.js";
import { decisionSummary } from "./schema.js";
import type { DecisionSummary } from "./decisionScoring.js";
import { requireDecisionResult } from "./documentKinds.js";
import { presentQuestion } from "../../runner/decisions/questions.js";
import {
  buildProviderRequest,
  parseProviderResponse,
  type ProviderAttempt,
} from "../../runner/decisions/providers.js";
import {
  DECISION_PROTOCOL,
  type ProviderConfig,
} from "../../runner/decisions/protocol.js";
import { type DecisionSourceSnapshot } from "../../runner/decisions/source.js";
import { canonicalJson, sameJson } from "./decisionIdentity.js";
import { validateDecisionSnapshot } from "./decisionSourceValidation.js";
import {
  BoundedSingleFlightCache,
  decisionSourceCacheKey,
  deepFreeze,
  mapWithConcurrency,
} from "./decisionIngestionPerformance.js";

const originValidator = v.union(
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

type Origin =
  | {
      kind: "github_actions";
      repository: string;
      workflow: string;
      runId: string;
      runAttempt: number;
      ref: string;
      sourceCommit: string;
    }
  | { kind: "development"; sourceCommit: string | null };

const DECISION_PRODUCTION_URL = "https://fabulous-panther-525.convex.cloud";
const DECISION_DEVELOPMENT_URL = "https://brazen-pelican-414.convex.cloud";
const DECISION_EVIDENCE_READ_CONCURRENCY = 8;
const sourceCache = new BoundedSingleFlightCache<DecisionSourceSnapshot>({
  maxEntries: 4,
  maxBytes: 32 * 1024 * 1024,
  ttlMs: 5 * 60 * 1000,
});

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function profileHash(profile: {
  reasoningEffort: "low" | "medium" | "high" | null;
  maxOutputTokens: number | null;
  timeoutMs: number;
  maxRetries: number;
  seed: string;
  repetitions: number;
}): string {
  // Keep field order fixed. This is an identity for effective settings, not a
  // benchmark version and not a hash of arbitrary caller JSON.
  return sha256(
    canonicalJson({
      reasoningEffort: profile.reasoningEffort,
      maxOutputTokens: profile.maxOutputTokens,
      timeoutMs: profile.timeoutMs,
      maxRetries: profile.maxRetries,
      seed: profile.seed,
      repetitions: profile.repetitions,
    }),
  );
}

function runKey(origin: Origin, clientRunKey: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(clientRunKey)) {
    throw new Error("clientRunKey must be a UUID");
  }
  return canonicalJson([origin, clientRunKey]);
}

async function authenticate(ctx: ActionCtx, token: string): Promise<void> {
  const valid = await ctx.runMutation(internal.auth.validateToken, {
    value: token,
  });
  if (!valid) throw new Error("Invalid authentication token");
}

async function readEvidence(
  url: string | null,
  expectedSha256: string,
  limits: {
    maxStoredBytes: number;
    maxJsonBytes: number;
    allowGzip: boolean;
  },
): Promise<{ value: unknown; bytes: Uint8Array }> {
  if (!url || !/^[a-f0-9]{64}$/.test(expectedSha256)) {
    throw new Error(
      "Decision evidence is unavailable or has an invalid digest",
    );
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error("Decision evidence could not be read");
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > limits.maxStoredBytes) {
    throw new Error("Decision evidence size is outside the accepted bounds");
  }
  if (!response.body) throw new Error("Decision evidence response has no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let storedLength = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    storedLength += value.length;
    if (storedLength > limits.maxStoredBytes) {
      await reader.cancel();
      throw new Error("Decision evidence size is outside the accepted bounds");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(storedLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  if (bytes.length === 0 || bytes.length > limits.maxStoredBytes) {
    throw new Error("Decision evidence size is outside the accepted bounds");
  }
  if (sha256(bytes) !== expectedSha256)
    throw new Error("Decision evidence hash mismatch");
  const gzip = bytes[0] === 0x1f && bytes[1] === 0x8b;
  if (gzip && !limits.allowGzip)
    throw new Error("Compressed evidence is not accepted here");
  let jsonBytes = bytes;
  if (gzip) {
    try {
      jsonBytes = new Uint8Array(
        gunzipSync(bytes, {
          maxOutputLength: limits.maxJsonBytes,
        }),
      );
    } catch {
      throw new Error(
        "Decision evidence gzip is invalid or exceeds its decoded limit",
      );
    }
  }
  if (jsonBytes.length > limits.maxJsonBytes) {
    throw new Error("Decoded decision evidence exceeds its accepted bound");
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(jsonBytes);
  const value = JSON.parse(text) as unknown;
  if (`${JSON.stringify(value)}\n` !== text) {
    throw new Error(
      "Decision evidence must use the canonical JSONL byte format",
    );
  }
  return { value, bytes };
}

type DecisionSourceExpectation = {
  version: string;
  evalCount: number;
  decision: NonNullable<Doc<"benchmarkVersions">["decision"]>;
};

function compactDecisionDefinition(
  snapshot: DecisionSourceSnapshot,
): NonNullable<Doc<"benchmarkVersions">["decision"]>["sources"] {
  return snapshot.banks.map((bank) => ({
    evalPath: bank.sourceEval,
    questions: bank.questions.map((question) => ({
      id: question.id,
      optionIds: question.options.map((option) => option.id),
      correctOptionId: question.correctOptionId,
    })),
  }));
}

function assertDecisionSourceMatches(
  snapshot: DecisionSourceSnapshot,
  expected: DecisionSourceExpectation,
): void {
  if (
    snapshot.artifactVersion !== 1 ||
    snapshot.kind !== "decision-source" ||
    snapshot.sourceCommit !== expected.decision.sourceCommit ||
    snapshot.protocol.version !== expected.decision.protocolVersion ||
    snapshot.benchmark.version !== expected.version ||
    snapshot.benchmark.evalCount !== expected.evalCount
  ) {
    throw new Error(
      "Decision source snapshot does not match the shared benchmark",
    );
  }
  if (
    !sameJson(compactDecisionDefinition(snapshot), expected.decision.sources)
  ) {
    throw new Error(
      "Compact decision definition differs from verified source evidence",
    );
  }
}

async function verifiedDecisionSource(
  ctx: ActionCtx,
  expected: DecisionSourceExpectation,
): Promise<DecisionSourceSnapshot> {
  const evidence = expected.decision.sourceEvidence;
  const key = decisionSourceCacheKey({
    deployment: process.env.CONVEX_CLOUD_URL ?? "",
    storageId: String(evidence.storageId),
    sha256: evidence.sha256,
    benchmarkVersion: expected.version,
  });
  const snapshot = await sourceCache.get(key, async () => {
    const url = await ctx.storage.getUrl(evidence.storageId);
    const read = await readEvidence(url, evidence.sha256, {
      maxStoredBytes: MAX_DECISION_SOURCE_EVIDENCE_BYTES,
      maxJsonBytes: MAX_DECISION_SOURCE_EVIDENCE_BYTES,
      allowGzip: false,
    });
    const validated = validateDecisionSnapshot(read.value);
    assertDecisionSourceMatches(validated, expected);
    return { value: deepFreeze(validated), sizeBytes: read.bytes.length };
  });
  // The cache only avoids repeating immutable byte validation. Stored benchmark
  // metadata remains the authority and is compared on every use.
  assertDecisionSourceMatches(snapshot, expected);
  return snapshot;
}

function decisionSource(
  snapshot: DecisionSourceSnapshot,
  questionKey: string,
): {
  bank: DecisionSourceSnapshot["banks"][number];
  question: DecisionSourceSnapshot["banks"][number]["questions"][number];
} {
  const slash = questionKey.lastIndexOf("/");
  if (slash <= 0) throw new Error("Invalid question key");
  const sourceEval = questionKey.slice(0, slash);
  const questionId = questionKey.slice(slash + 1);
  const bank = snapshot.banks.find(
    (candidate) => candidate.sourceEval === sourceEval,
  );
  const question = bank?.questions.find(
    (candidate) => candidate.id === questionId,
  );
  if (!bank || !question)
    throw new Error("Question is absent from immutable source evidence");
  return { bank, question };
}

function providerConfig(run: {
  model: string;
  profile: {
    reasoningEffort: "low" | "medium" | "high" | null;
    maxOutputTokens: number | null;
    timeoutMs: number;
    maxRetries: number;
  };
}): ProviderConfig {
  const native = ["typesafe/jev-1.13", "~typesafe/jev-latest"].includes(
    run.model,
  );
  if (
    native &&
    (run.profile.reasoningEffort !== null ||
      run.profile.maxOutputTokens !== null)
  ) {
    throw new Error("Native Jev profiles must use null chat-only settings");
  }
  if (
    !native &&
    (run.profile.reasoningEffort === null ||
      run.profile.maxOutputTokens === null)
  ) {
    throw new Error(
      "Chat decision profiles require reasoning and output-token settings",
    );
  }
  return {
    provider: "openrouter" as const,
    model: run.model,
    reasoningEffort: run.profile.reasoningEffort ?? "low",
    maxOutputTokens: run.profile.maxOutputTokens ?? 1,
    timeoutMs: run.profile.timeoutMs,
    maxRetries: run.profile.maxRetries,
  };
}

function assertAllowedOrigin(origin: Origin): void {
  const deploymentUrl = process.env.CONVEX_CLOUD_URL;
  if (origin.kind === "development") {
    if (deploymentUrl !== DECISION_DEVELOPMENT_URL) {
      throw new Error(
        "Development decision reporting is allowed only on the development deployment",
      );
    }
    if (
      origin.sourceCommit !== null &&
      !/^[a-f0-9]{40}$/.test(origin.sourceCommit)
    ) {
      throw new Error("Development origin has an invalid source commit");
    }
    return;
  }
  if (
    deploymentUrl !== DECISION_PRODUCTION_URL ||
    origin.repository !== "get-convex/convex-evals" ||
    origin.ref !== "refs/heads/main" ||
    ![
      "get-convex/convex-evals/.github/workflows/decision_evals.yml@refs/heads/main",
      "get-convex/convex-evals/.github/workflows/mint_benchmark.yml@refs/heads/main",
    ].includes(origin.workflow) ||
    !/^\d+$/.test(origin.runId) ||
    !Number.isSafeInteger(origin.runAttempt) ||
    origin.runAttempt < 1 ||
    !/^[a-f0-9]{40}$/.test(origin.sourceCommit)
  )
    throw new Error(
      "Production decision reporting requires the approved main workflow",
    );
}

function attemptCost(attempt: ProviderAttempt): number | null {
  const response = attempt.response;
  if (!response || typeof response !== "object" || Array.isArray(response))
    return null;
  const usage = (response as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;
  const cost = (usage as { cost?: unknown }).cost;
  return typeof cost === "number" && Number.isFinite(cost) && cost >= 0
    ? cost
    : null;
}

function splitFullKey(key: string): {
  questionKey: string;
  repetition: number;
} {
  const slash = key.lastIndexOf("/");
  const repetition = Number(key.slice(slash + 1));
  if (slash <= 0 || !Number.isSafeInteger(repetition) || repetition < 0) {
    throw new Error(`Invalid planned decision key: ${key}`);
  }
  return { questionKey: key.slice(0, slash), repetition };
}

function expectedQuestion(
  snapshot: DecisionSourceSnapshot,
  run: {
    condition: "no_guidelines" | "with_guidelines";
    profile: { seed: string };
    model: string;
  } & Parameters<typeof providerConfig>[0],
  key: string,
  config = providerConfig(run),
): {
  questionKey: string;
  repetition: number;
  bank: DecisionSourceSnapshot["banks"][number];
  question: DecisionSourceSnapshot["banks"][number]["questions"][number];
  presented: ReturnType<typeof presentQuestion>;
  request: Record<string, unknown>;
} {
  const { questionKey, repetition } = splitFullKey(key);
  const { bank, question } = decisionSource(snapshot, questionKey);
  const presented = presentQuestion(
    question,
    bank.sourceEval,
    run.profile.seed,
    repetition,
  );
  const request = buildProviderRequest(
    config,
    presented,
    run.condition === "with_guidelines" ? snapshot.guidelines : "",
  );
  return { questionKey, repetition, bank, question, presented, request };
}

function validateAttempt(
  value: unknown,
  expectedAttempt?: number,
): ProviderAttempt {
  const attempt = object(
    value,
    "Provider attempt",
  ) as unknown as ProviderAttempt;
  if (
    !Number.isSafeInteger(attempt.attempt) ||
    attempt.attempt < 1 ||
    (expectedAttempt !== undefined && attempt.attempt !== expectedAttempt) ||
    typeof attempt.startedAt !== "string" ||
    !Number.isFinite(Date.parse(attempt.startedAt)) ||
    !Number.isFinite(attempt.durationMs) ||
    attempt.durationMs < 0 ||
    (attempt.httpStatus !== null &&
      (!Number.isSafeInteger(attempt.httpStatus) ||
        attempt.httpStatus < 100 ||
        attempt.httpStatus > 599)) ||
    (attempt.error !== null && typeof attempt.error !== "string")
  )
    throw new Error("Invalid provider attempt journal row");
  return attempt;
}

function validateRequestBinding(
  row: Record<string, unknown>,
  expectedRequest: Record<string, unknown>,
): void {
  const expectedDigest = sha256(canonicalJson(expectedRequest));
  if (row.request !== undefined && !sameJson(row.request, expectedRequest)) {
    throw new Error("Attempt journal request differs from the immutable plan");
  }
  if (
    row.requestSha256 !== undefined &&
    (typeof row.requestSha256 !== "string" ||
      row.requestSha256 !== expectedDigest)
  ) {
    throw new Error(
      "Attempt journal request digest differs from the immutable plan",
    );
  }
  if (row.request === undefined && row.requestSha256 === undefined) {
    throw new Error("Attempt journal has no request binding");
  }
}

export const start = action({
  args: {
    token: v.string(),
    clientRunKey: v.string(),
    benchmarkHash: v.string(),
    model: v.string(),
    condition: decisionCondition,
    profile: decisionProfile,
    plannedQuestions: v.array(v.string()),
    origin: originValidator,
  },
  returns: v.object({
    runId: v.id("runs"),
    profileHash: v.string(),
    fullSuite: v.boolean(),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{
    runId: Id<"runs">;
    profileHash: string;
    fullSuite: boolean;
  }> => {
    assertDecisionIngestionEnabled();
    await authenticate(ctx, args.token);
    assertAllowedOrigin(args.origin);
    providerConfig({ model: args.model, profile: args.profile });
    const hash = profileHash(args.profile);
    return await ctx.runMutation(internal.decisionStorage.createDecisionRun, {
      runKey: runKey(args.origin, args.clientRunKey),
      benchmarkHash: args.benchmarkHash,
      model: args.model,
      condition: args.condition,
      profile: args.profile,
      profileHash: hash,
      plannedQuestions: args.plannedQuestions,
      origin: args.origin,
    });
  },
});

export const generateUploadUrl = action({
  args: { token: v.string(), runId: v.id("runs") },
  returns: v.string(),
  handler: async (ctx, args) => {
    assertDecisionIngestionEnabled();
    await authenticate(ctx, args.token);
    await ctx.runQuery(internal.decisionStorage.getDecisionParent, {
      runId: args.runId,
    });
    return await ctx.storage.generateUploadUrl();
  },
});

export const record = action({
  args: {
    token: v.string(),
    runId: v.id("runs"),
    items: v.array(
      v.object({
        questionKey: v.string(),
        repetition: v.number(),
        evidence: decisionEvidence,
      }),
    ),
  },
  returns: v.object({ inserted: v.number(), unchanged: v.number() }),
  handler: async (
    ctx,
    args,
  ): Promise<{ inserted: number; unchanged: number }> => {
    assertDecisionIngestionEnabled();
    await authenticate(ctx, args.token);
    if (
      args.items.length === 0 ||
      args.items.length > MAX_DECISION_RECORD_BATCH
    ) {
      throw new Error("Decision result batches contain 1 to 25 items");
    }
    const context = await ctx.runQuery(
      internal.decisionStorage.getDecisionSourceContext,
      {
        runId: args.runId,
      },
    );
    if (context.run.status !== "running")
      throw new Error("Decision run is terminal");
    const snapshot = await verifiedDecisionSource(ctx, {
      version: context.benchmark.version,
      evalCount: context.benchmark.evalCount,
      decision: context.benchmark.decision!,
    });
    const config = providerConfig(context.run);
    const derived = await mapWithConcurrency(
      args.items,
      DECISION_EVIDENCE_READ_CONCURRENCY,
      async (item) => {
        const url = await ctx.storage.getUrl(item.evidence.storageId);
        const read = await readEvidence(url, item.evidence.sha256, {
          maxStoredBytes: MAX_DECISION_QUESTION_EVIDENCE_BYTES,
          maxJsonBytes: MAX_DECISION_QUESTION_EVIDENCE_BYTES,
          allowGzip: false,
        });
        const envelope = object(read.value, "Question evidence");
        const fullKey = `${item.questionKey}/${item.repetition}`;
        if (
          envelope.artifactVersion !== 1 ||
          envelope.kind !== "decision-question" ||
          envelope.runId !== String(args.runId) ||
          envelope.key !== fullKey
        )
          throw new Error(
            "Question evidence identity does not match the result slot",
          );
        const { bank, question } = decisionSource(snapshot, item.questionKey);
        const presented = presentQuestion(
          question,
          bank.sourceEval,
          context.run.profile.seed,
          item.repetition,
        );
        const guidelines =
          context.run.condition === "with_guidelines"
            ? snapshot.guidelines
            : "";
        const expectedRequest = buildProviderRequest(
          config,
          presented,
          guidelines,
        );
        if (!sameJson(envelope.request, expectedRequest))
          throw new Error("Provider request mismatch");
        const result = object(envelope.result, "Question result");
        if (result.key !== fullKey)
          throw new Error("Question result key mismatch");
        const outcome = object(result.outcome, "Question outcome");
        if (
          !Array.isArray(outcome.attempts) ||
          outcome.attempts.length === 0 ||
          outcome.attempts.length > context.run.profile.maxRetries + 1
        ) {
          throw new Error("Question evidence has an invalid attempt count");
        }
        const attempts = outcome.attempts.map((value, index) => {
          return validateAttempt(value, index + 1);
        });
        if (
          typeof outcome.durationMs !== "number" ||
          !Number.isFinite(outcome.durationMs) ||
          outcome.durationMs <
            attempts.reduce((sum, attempt) => sum + attempt.durationMs, 0)
        ) {
          throw new Error("Question duration does not cover its attempts");
        }
        const last = attempts.at(-1)!;
        let classified: "answered" | "invalid_response" | "provider_error";
        let selectedCanonicalId: string | null = null;
        let returnedModel: string | null = null;
        if (
          last.error ||
          last.httpStatus === null ||
          last.httpStatus < 200 ||
          last.httpStatus >= 300
        ) {
          classified = "provider_error";
        } else {
          try {
            const parsed = parseProviderResponse(config, last.response, [
              "A",
              "B",
              "C",
              "D",
            ]);
            classified = "answered";
            selectedCanonicalId =
              presented.displayToCanonical[parsed.choice] ?? null;
            returnedModel = parsed.returnedModel;
          } catch {
            classified = "invalid_response";
          }
        }
        const costs = attempts.map(attemptCost);
        const knownCostUsd = costs.reduce<number>(
          (sum, cost) => sum + (cost ?? 0),
          0,
        );
        return {
          questionKey: item.questionKey,
          repetition: item.repetition,
          outcome: classified,
          selectedCanonicalId,
          correct:
            classified === "answered" &&
            selectedCanonicalId === question.correctOptionId,
          returnedModel,
          durationMs: outcome.durationMs,
          requestAttempts: attempts.length,
          costUsd: costs.every((cost) => cost !== null) ? knownCostUsd : null,
          knownCostUsd,
          evidence: item.evidence,
        };
      },
    );
    return await ctx.runMutation(
      internal.decisionStorage.recordDecisionResults,
      {
        runId: args.runId,
        items: derived,
      },
    );
  },
});

export const finish = action({
  args: { token: v.string(), runId: v.id("runs"), evidence: decisionEvidence },
  returns: v.object({
    status: v.union(v.literal("completed"), v.literal("interrupted")),
    summary: decisionSummary,
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{
    status: "completed" | "interrupted";
    summary: DecisionSummary;
  }> => {
    assertDecisionIngestionEnabled();
    await authenticate(ctx, args.token);
    const context = await ctx.runQuery(
      internal.decisionStorage.getDecisionFinalizationContext,
      {
        runId: args.runId,
      },
    );
    const url = await ctx.storage.getUrl(args.evidence.storageId);
    const read = await readEvidence(url, args.evidence.sha256, {
      maxStoredBytes: MAX_DECISION_RUN_EVIDENCE_COMPRESSED_BYTES,
      maxJsonBytes: MAX_DECISION_RUN_EVIDENCE_DECOMPRESSED_BYTES,
      allowGzip: true,
    });
    const envelope = object(read.value, "Run evidence");
    if (
      envelope.artifactVersion !== 1 ||
      envelope.kind !== "decision-run" ||
      envelope.runId !== String(args.runId)
    )
      throw new Error("Run evidence identity mismatch");
    const clientRunKey = envelope.clientRunKey;
    if (
      typeof clientRunKey !== "string" ||
      runKey(context.run.origin, clientRunKey) !== context.run.runKey ||
      !sameJson(envelope.origin, context.run.origin)
    ) {
      throw new Error("Run evidence provenance mismatch");
    }
    const manifest = object(envelope.manifest, "Hosted manifest");
    const manifestConfig = object(manifest.config, "Manifest config");
    const manifestBenchmark = object(manifest.benchmark, "Manifest benchmark");
    if (
      manifest.artifactVersion !== 1 ||
      manifest.scope === "local-only" ||
      manifest.benchmarkStatus !== "minted" ||
      manifestConfig.provider !== "openrouter" ||
      manifestConfig.model !== context.run.model ||
      manifest.condition !== context.run.condition ||
      manifestConfig.timeoutMs !== context.run.profile.timeoutMs ||
      manifestConfig.maxRetries !== context.run.profile.maxRetries ||
      manifest.seed !== context.run.profile.seed ||
      manifest.repetitions !== context.run.profile.repetitions ||
      manifestBenchmark.version !== context.benchmark.version ||
      !sameJson(manifest.protocol, DECISION_PROTOCOL)
    )
      throw new Error(
        "Hosted manifest does not match the immutable decision run",
      );
    const config = providerConfig(context.run);
    if (
      context.run.profile.reasoningEffort !== null &&
      manifestConfig.reasoningEffort !== context.run.profile.reasoningEffort
    )
      throw new Error(
        "Manifest reasoning effort does not match the effective profile",
      );
    if (
      context.run.profile.maxOutputTokens !== null &&
      manifestConfig.maxOutputTokens !== context.run.profile.maxOutputTokens
    )
      throw new Error(
        "Manifest output-token limit does not match the effective profile",
      );
    if (context.run.origin.kind === "github_actions") {
      if (
        manifest.scope !== "github-actions" ||
        manifest.sourceCommit !== context.run.origin.sourceCommit
      ) {
        throw new Error("GitHub Actions manifest provenance mismatch");
      }
    } else if (
      manifest.scope !== "development" ||
      manifest.sourceCommit !== context.run.origin.sourceCommit
    ) {
      throw new Error("Development manifest provenance mismatch");
    }
    const provenance = manifest.provenance;
    if (
      provenance &&
      typeof provenance === "object" &&
      (provenance as { operation?: unknown }).operation === "offline-regrade"
    ) {
      throw new Error("Offline regrades cannot be hosted");
    }
    const snapshot = await verifiedDecisionSource(ctx, {
      version: context.benchmark.version,
      evalCount: context.benchmark.evalCount,
      decision: context.benchmark.decision!,
    });
    if (!Array.isArray(manifest.planned))
      throw new Error("Hosted manifest plan is missing");
    const expectedBySlot = new Map<
      string,
      ReturnType<typeof expectedQuestion>
    >();
    for (const questionKey of context.run.plannedQuestions) {
      for (
        let repetition = 0;
        repetition < context.run.profile.repetitions;
        repetition++
      ) {
        const key = `${questionKey}/${repetition}`;
        expectedBySlot.set(
          key,
          expectedQuestion(snapshot, context.run, key, config),
        );
      }
    }
    const expectedForSlot = (
      key: string,
    ): ReturnType<typeof expectedQuestion> => {
      const expected = expectedBySlot.get(key);
      if (!expected)
        throw new Error("Decision evidence is outside the stored exact plan");
      return expected;
    };
    const manifestSlots = new Set<string>();
    for (const value of manifest.planned) {
      const item = object(value, "Manifest planned question");
      if (typeof item.key !== "string")
        throw new Error("Manifest question key is missing");
      if (manifestSlots.has(item.key))
        throw new Error("Manifest plan contains a duplicate slot");
      manifestSlots.add(item.key);
      const expected = expectedForSlot(item.key);
      if (
        item.sourceEval !== expected.bank.sourceEval ||
        item.repetition !== expected.repetition ||
        !sameJson(item.question, expected.question) ||
        !sameJson(item.presented, expected.presented)
      )
        throw new Error("Manifest plan differs from immutable source evidence");
    }
    if (
      manifestSlots.size !== expectedBySlot.size ||
      [...manifestSlots].some((slot) => !expectedBySlot.has(slot))
    ) {
      throw new Error("Manifest plan does not match the stored exact plan");
    }
    if (
      !Array.isArray(envelope.resultEvidence) ||
      !Array.isArray(envelope.attempts) ||
      !Array.isArray(envelope.attemptStarts)
    )
      throw new Error("Run journals are missing");
    const resultEvidence = envelope.resultEvidence.map((value) => {
      const item = object(value, "Result evidence reference");
      const evidence = object(item.evidence, "Result evidence digest");
      if (
        typeof item.questionKey !== "string" ||
        !Number.isSafeInteger(item.repetition) ||
        typeof evidence.storageId !== "string" ||
        typeof evidence.sha256 !== "string"
      )
        throw new Error("Invalid result evidence reference");
      return {
        questionKey: item.questionKey,
        repetition: item.repetition as number,
        storageId: evidence.storageId as Id<"_storage">,
        sha256: evidence.sha256,
      };
    });
    // Re-read each immutable question blob and reconcile its completed attempts
    // with the final journal. The journal is the authority for orphan attempts,
    // while the blobs prove which attempts produced persisted outcomes.
    const persistedAttempts = new Map<string, ProviderAttempt>();
    const persisted = await mapWithConcurrency(
      context.results,
      DECISION_EVIDENCE_READ_CONCURRENCY,
      async (storedValue) => {
        const storedResult = requireDecisionResult(storedValue);
        const evidence = storedResult.evidence;
        const questionUrl = await ctx.storage.getUrl(evidence.storageId);
        const questionRead = await readEvidence(questionUrl, evidence.sha256, {
          maxStoredBytes: MAX_DECISION_QUESTION_EVIDENCE_BYTES,
          maxJsonBytes: MAX_DECISION_QUESTION_EVIDENCE_BYTES,
          allowGzip: false,
        });
        const questionEnvelope = object(
          questionRead.value,
          "Persisted question evidence",
        );
        const fullKey = `${storedResult.questionKey}/${storedResult.repetition}`;
        const expected = expectedForSlot(fullKey);
        if (
          questionEnvelope.artifactVersion !== 1 ||
          questionEnvelope.kind !== "decision-question" ||
          questionEnvelope.runId !== String(args.runId) ||
          questionEnvelope.key !== fullKey ||
          !sameJson(questionEnvelope.request, expected.request)
        )
          throw new Error(
            "Persisted question evidence changed or targets another slot",
          );
        const result = object(
          questionEnvelope.result,
          "Persisted question result",
        );
        const outcome = object(result.outcome, "Persisted question outcome");
        if (
          !Array.isArray(outcome.attempts) ||
          outcome.attempts.length !== storedResult.requestAttempts
        ) {
          throw new Error("Persisted result attempt count is inconsistent");
        }
        return outcome.attempts.map((value, index) => ({
          id: `${storedResult.questionKey}/${storedResult.repetition}/${index + 1}`,
          attempt: validateAttempt(value, index + 1),
        }));
      },
    );
    for (const attempts of persisted) {
      for (const { id, attempt } of attempts)
        persistedAttempts.set(id, attempt);
    }
    const completed = new Map<string, Record<string, unknown>>();
    let orphanAttempts = 0;
    let orphanKnownCostUsd = 0;
    let hasUnknownOrphanCost = false;
    for (const value of envelope.attempts) {
      const attempt = object(value, "Attempt journal row");
      if (
        typeof attempt.key !== "string" ||
        typeof attempt.attempt !== "number" ||
        !Number.isSafeInteger(attempt.attempt)
      ) {
        throw new Error("Invalid attempt journal identity");
      }
      const id = `${attempt.key}/${attempt.attempt}`;
      if (completed.has(id))
        throw new Error("Duplicate completed attempt journal row");
      const expected = expectedForSlot(attempt.key);
      validateRequestBinding(attempt, expected.request);
      const parsedAttempt = validateAttempt(attempt);
      if (parsedAttempt.attempt > context.run.profile.maxRetries + 1) {
        throw new Error("Attempt journal exceeds the stored retry profile");
      }
      const persisted = persistedAttempts.get(id);
      if (persisted) {
        if (
          !sameJson(
            {
              attempt: parsedAttempt.attempt,
              startedAt: parsedAttempt.startedAt,
              durationMs: parsedAttempt.durationMs,
              httpStatus: parsedAttempt.httpStatus,
              response: parsedAttempt.response,
              error: parsedAttempt.error,
            },
            persisted,
          )
        )
          throw new Error("Attempt journal conflicts with question evidence");
      } else {
        orphanAttempts++;
        const cost = attemptCost(parsedAttempt);
        if (cost === null) hasUnknownOrphanCost = true;
        else orphanKnownCostUsd += cost;
      }
      completed.set(id, attempt);
    }
    for (const id of persistedAttempts.keys()) {
      if (!completed.has(id))
        throw new Error("Final journal omitted a persisted provider attempt");
    }
    const starts = new Set<string>();
    for (const value of envelope.attemptStarts) {
      const start = object(value, "Attempt start row");
      if (
        typeof start.key !== "string" ||
        typeof start.attempt !== "number" ||
        !Number.isSafeInteger(start.attempt) ||
        typeof start.startedAt !== "string" ||
        !Number.isFinite(Date.parse(start.startedAt))
      ) {
        throw new Error("Invalid attempt start row");
      }
      if (
        start.attempt < 1 ||
        start.attempt > context.run.profile.maxRetries + 1
      ) {
        throw new Error("Attempt start exceeds the stored retry profile");
      }
      const id = `${start.key}/${start.attempt}`;
      if (starts.has(id)) throw new Error("Duplicate attempt start row");
      const expected = expectedForSlot(start.key);
      validateRequestBinding(start, expected.request);
      const completedAttempt = completed.get(id);
      if (completedAttempt && completedAttempt.startedAt !== start.startedAt) {
        throw new Error(
          "Attempt start time differs from the completed journal row",
        );
      }
      starts.add(id);
      if (!completed.has(id)) {
        orphanAttempts++;
        hasUnknownOrphanCost = true;
      }
    }
    for (const id of completed.keys()) {
      if (!starts.has(id))
        throw new Error("Completed attempt has no matching start");
    }
    const status = object(envelope.status, "Run status");
    const finishedAt =
      typeof envelope.finishedAt === "string"
        ? Date.parse(envelope.finishedAt)
        : NaN;
    if (
      !Number.isFinite(finishedAt) ||
      typeof envelope.durationMs !== "number" ||
      !Number.isFinite(envelope.durationMs) ||
      envelope.durationMs < 0
    ) {
      throw new Error("Invalid run completion timing");
    }
    const finalized = await ctx.runMutation(
      internal.decisionStorage.finalizeDecisionRun,
      {
        runId: args.runId,
        evidence: args.evidence,
        resultEvidence,
        finishedAt,
        durationMs: envelope.durationMs,
        failureReason:
          typeof status.stopReason === "string" ? status.stopReason : null,
        orphanAttempts,
        orphanKnownCostUsd,
        hasUnknownOrphanCost,
      },
    );
    if (
      finalized.status !== "completed" &&
      finalized.status !== "interrupted"
    ) {
      throw new Error("Invalid terminal decision status");
    }
    return { status: finalized.status, summary: finalized.summary };
  },
});

export const mintBenchmark = action({
  args: {
    token: v.string(),
    version: v.string(),
    evalCount: v.number(),
    curatedModels: v.array(v.string()),
    decision: decisionDefinition,
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    assertDecisionIngestionEnabled();
    await authenticate(ctx, args.token);
    await verifiedDecisionSource(ctx, {
      version: args.version,
      evalCount: args.evalCount,
      decision: args.decision,
    });
    await ctx.runMutation(internal.benchmarkVersions.mint, {
      version: args.version,
      evalCount: args.evalCount,
      curatedModels: args.curatedModels,
      decision: args.decision,
    });
    return null;
  },
});
