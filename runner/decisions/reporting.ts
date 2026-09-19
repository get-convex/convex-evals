import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { makeFunctionReference } from "convex/server";
import type { DecisionRunHooks, DecisionRunMetadata } from "./run.js";
import { sha256 } from "./source.js";
import { usesNativeDecisionApi } from "./providers.js";
import { canonicalJson } from "../../evalScores/convex/decisionIdentity.js";
import {
  MAX_DECISION_QUESTION_EVIDENCE_BYTES,
  MAX_DECISION_RUN_EVIDENCE_COMPRESSED_BYTES,
} from "../../evalScores/convex/decisionConfig.js";

export const DECISION_PRODUCTION_URL =
  "https://fabulous-panther-525.convex.cloud";
export const DECISION_DEVELOPMENT_URL =
  "https://brazen-pelican-414.convex.cloud";

export type DecisionOrigin =
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

export interface ReportingTarget {
  url: string;
  token: string;
  origin: DecisionOrigin;
  metadata: DecisionRunMetadata;
}

/** Follow the repository's trusted CI bearer-token boundary. These environment
 * checks prevent accidental local reporting; they are not an OIDC attestation. */
export function decisionReportingTarget(
  env: Record<string, string | undefined>,
  sourceCommit: string,
  mode: "ci" | "development" = "ci",
): ReportingTarget | null {
  if (env.DISABLE_CONVEX_REPORTING === "1") return null;
  if (!/^[a-f0-9]{40}$/.test(sourceCommit))
    throw new Error("Invalid checkout commit");
  if (!env.CONVEX_EVAL_URL || !env.CONVEX_AUTH_TOKEN)
    throw new Error(
      "CONVEX_EVAL_URL and CONVEX_AUTH_TOKEN are required for hosted decision runs",
    );
  const parsed = new URL(env.CONVEX_EVAL_URL);
  if (
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname !== "/"
  )
    throw new Error("Expected a Convex deployment origin");
  const url = parsed.origin;
  if (mode === "development") {
    if (url !== DECISION_DEVELOPMENT_URL)
      throw new Error(
        "Local decision reporting is allowed only on the development deployment",
      );
    return {
      url,
      token: env.CONVEX_AUTH_TOKEN,
      origin: { kind: "development", sourceCommit },
      metadata: {
        scope: "development",
        sourceCommit,
        runnerLocation: "development runner",
      },
    };
  }
  const runAttempt = Number(env.GITHUB_RUN_ATTEMPT);
  if (
    url !== DECISION_PRODUCTION_URL ||
    env.GITHUB_ACTIONS !== "true" ||
    env.GITHUB_REF !== "refs/heads/main" ||
    env.GITHUB_REPOSITORY !== "get-convex/convex-evals" ||
    env.GITHUB_SHA !== sourceCommit ||
    !/^\d+$/.test(env.GITHUB_RUN_ID ?? "") ||
    !Number.isSafeInteger(runAttempt) ||
    runAttempt < 1 ||
    ![
      "get-convex/convex-evals/.github/workflows/decision_evals.yml@refs/heads/main",
      "get-convex/convex-evals/.github/workflows/mint_benchmark.yml@refs/heads/main",
    ].includes(env.GITHUB_WORKFLOW_REF ?? "")
  )
    throw new Error(
      "Production decision reporting requires the approved main-branch GitHub Actions workflow",
    );
  return {
    url,
    token: env.CONVEX_AUTH_TOKEN,
    origin: {
      kind: "github_actions",
      repository: env.GITHUB_REPOSITORY,
      workflow: env.GITHUB_WORKFLOW_REF!,
      runId: env.GITHUB_RUN_ID!,
      runAttempt,
      ref: env.GITHUB_REF,
      sourceCommit,
    },
    metadata: {
      scope: "github-actions",
      sourceCommit,
      runnerLocation: "GitHub Actions",
    },
  };
}

export interface DecisionEvidence {
  storageId: string;
  sha256: string;
}

export interface DecisionTransport {
  action(name: string, args: Record<string, unknown>): Promise<unknown>;
  upload(
    url: string,
    bytes: string | Uint8Array,
    contentType?: "application/json" | "application/gzip",
  ): Promise<string>;
}

export function compactDecisionJournalRow(
  value: unknown,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid local attempt journal row");
  }
  const { request, ...row } = value as Record<string, unknown>;
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new Error("Attempt journal request is missing");
  }
  return {
    ...row,
    requestSha256: sha256(canonicalJson(request)),
  };
}

export function encodeDecisionRunEvidence(value: unknown): Uint8Array {
  return gzipSync(`${JSON.stringify(value)}\n`, { level: 9 });
}

export async function decisionTransport(
  url: string,
): Promise<DecisionTransport> {
  // Delayed construction keeps disabled/file-only paths entirely offline.
  const { ConvexHttpClient } = await import("convex/browser");
  const client = new ConvexHttpClient(url);
  return {
    action: (name, args) =>
      client.action(
        makeFunctionReference<"action">(name),
        args,
      ) as Promise<unknown>,
    async upload(uploadUrl, bytes, contentType = "application/json") {
      const response = await fetch(uploadUrl, {
        method: "POST",
        headers: { "Content-Type": contentType },
        body: bytes,
      });
      if (!response.ok)
        throw new Error(`Evidence upload failed (HTTP ${response.status})`);
      const value = (await response.json()) as { storageId?: unknown };
      if (typeof value.storageId !== "string")
        throw new Error("Evidence upload returned no storage ID");
      return value.storageId;
    },
  };
}

export function createDecisionReporter(
  target: ReportingTarget,
  clientRunKey: string,
  transport: DecisionTransport,
  retryDelay: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
): DecisionRunHooks {
  let runId: string | null = null;
  let evidenceDirectory: string | null = null;
  const resultEvidence: Array<{
    questionKey: string;
    repetition: number;
    evidence: DecisionEvidence;
  }> = [];
  const call = async (
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await transport.action(name, args);
      } catch (error) {
        if (attempt === 2) throw error;
        // Retries reuse the immutable run key/evidence digest. They never repeat
        // inference after an ambiguous response from the reporting backend.
        await retryDelay(1000 * (attempt + 1));
      }
    }
  };
  const upload = async (
    value: unknown,
    gzip = false,
    maxStoredBytes = MAX_DECISION_QUESTION_EVIDENCE_BYTES,
  ): Promise<DecisionEvidence> => {
    if (!runId) throw new Error("Run must start before evidence is uploaded");
    const json = JSON.stringify(value) + "\n";
    const bytes = gzip ? encodeDecisionRunEvidence(value) : json;
    const storedLength = typeof bytes === "string" ? Buffer.byteLength(bytes) : bytes.length;
    if (storedLength > maxStoredBytes) {
      throw new Error("Hosted decision evidence exceeds its upload limit");
    }
    const url = await call("decisionAdmin:generateUploadUrl", {
      token: target.token,
      runId,
    });
    if (typeof url !== "string") throw new Error("Invalid evidence upload URL");
    const digest = sha256(bytes);
    if (!evidenceDirectory) throw new Error("Evidence directory unavailable");
    writeFileSync(join(evidenceDirectory, `${digest}.${gzip ? "json.gz" : "json"}`), bytes, {
      mode: 0o600,
    });
    const storageId = await transport.upload(
      url,
      bytes,
      gzip ? "application/gzip" : "application/json",
    );
    return { storageId, sha256: digest };
  };
  return {
    metadata: target.metadata,
    async onStart(directory, manifest) {
      if (manifest.config.provider !== "openrouter")
        throw new Error(
          "Hosted decision reporting requires the OpenRouter provider",
        );
      evidenceDirectory = join(directory, "evidence");
      mkdirSync(evidenceDirectory, { recursive: true, mode: 0o700 });
      const config = manifest.config;
      const reply = (await call("decisionAdmin:start", {
        token: target.token,
        clientRunKey,
        benchmarkHash: manifest.benchmark.version,
        model: config.model,
        condition: manifest.condition,
        profile: {
          reasoningEffort: usesNativeDecisionApi(config)
            ? null
            : config.reasoningEffort,
          maxOutputTokens: usesNativeDecisionApi(config)
            ? null
            : config.maxOutputTokens,
          timeoutMs: config.timeoutMs,
          maxRetries: config.maxRetries,
          seed: manifest.seed,
          repetitions: manifest.repetitions,
        },
        plannedQuestions: [
          ...new Set(
            manifest.planned.map(
              (item) => `${item.sourceEval}/${item.question.id}`,
            ),
          ),
        ].sort(),
        origin: target.origin,
      })) as { runId?: unknown };
      if (typeof reply?.runId !== "string")
        throw new Error("Decision run was not created");
      runId = reply.runId;
    },
    async onResult(item, request, result) {
      const evidence = await upload({
        artifactVersion: 1,
        kind: "decision-question",
        runId,
        key: item.key,
        request,
        result,
      });
      const entry = {
        questionKey: `${item.sourceEval}/${item.question.id}`,
        repetition: item.repetition,
        evidence,
      };
      await call("decisionAdmin:record", {
        token: target.token,
        runId,
        items: [entry],
      });
      resultEvidence.push(entry);
    },
    async onFinish(directory, durationMs) {
      const json = (file: string): unknown =>
        JSON.parse(readFileSync(join(directory, file), "utf8")) as unknown;
      const lines = (file: string): unknown[] =>
        readFileSync(join(directory, file), "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as unknown);
      const evidence = await upload({
        artifactVersion: 1,
        kind: "decision-run",
        runId,
        clientRunKey,
        origin: target.origin,
        manifest: json("manifest.json"),
        status: json("status.json"),
        finishedAt: new Date().toISOString(),
        durationMs,
        resultEvidence,
        attempts: lines("attempts.jsonl").map(compactDecisionJournalRow),
        attemptStarts: lines("attempt-starts.jsonl").map(compactDecisionJournalRow),
      }, true, MAX_DECISION_RUN_EVIDENCE_COMPRESSED_BYTES);
      const reply = (await call("decisionAdmin:finish", {
        token: target.token,
        runId,
        evidence,
      })) as { status?: unknown };
      if (reply?.status !== "completed")
        throw new Error(
          `Hosted decision run is ${typeof reply?.status === "string" ? reply.status : "unconfirmed"}; local artifacts retained`,
        );
    },
  };
}
