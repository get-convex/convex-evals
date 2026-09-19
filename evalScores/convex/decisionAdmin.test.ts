import { createHash, randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { convexTest } from "convex-test";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./decisionConfig.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./decisionConfig.js")>();
  return {
    ...original,
    DECISION_INGESTION_ENABLED: true,
    assertDecisionIngestionEnabled: () => undefined,
  };
});

import { api } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import schema from "./schema.js";
import { modules } from "./test.setup.js";
import { createDecisionSourceSnapshot } from "../../runner/decisions/source.js";
import { presentQuestion } from "../../runner/decisions/questions.js";
import { buildProviderRequest } from "../../runner/decisions/providers.js";
import { canonicalJson } from "./decisionIdentity.js";

const repositoryRoot = new URL("../../", import.meta.url).pathname;
const sourceCommit = "a".repeat(40);
const bytes = (value: unknown): string => `${JSON.stringify(value)}\n`;
const digest = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

describe("decision ingestion actions", () => {
  beforeEach(() => {
    vi.stubEnv("CONVEX_CLOUD_URL", "https://brazen-pelican-414.convex.cloud");
  });

  it("verifies immutable source, request, raw answer, journals, and final exact set", async () => {
    const t = convexTest(schema, modules);
    const snapshot = createDecisionSourceSnapshot(repositoryRoot, sourceCommit);
    const sourceBytes = bytes(snapshot);
    const sourceStorageId = await t.run((ctx) =>
      ctx.storage.store(new Blob([sourceBytes], { type: "application/json" })),
    );
    const sourceUrl = await t.run((ctx) => ctx.storage.getUrl(sourceStorageId));
    if (!sourceUrl) throw new Error("Missing test source URL");
    const evidenceByUrl = new Map<string, string | Uint8Array>([
      [sourceUrl, sourceBytes],
    ]);
    let sourceReads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input instanceof Request ? input.url : input);
        const evidence = evidenceByUrl.get(url);
        if (url === sourceUrl) sourceReads++;
        return evidence
          ? new Response(
              typeof evidence === "string" ? evidence : new Blob([evidence]),
              { status: 200 },
            )
          : new Response("missing", { status: 404 });
      }),
    );
    const storeEvidence = async (
      value: unknown,
    ): Promise<{ storageId: Id<"_storage">; sha256: string }> => {
      const content = bytes(value);
      const storageId = await t.run((ctx) =>
        ctx.storage.store(new Blob([content], { type: "application/json" })),
      );
      const url = await t.run((ctx) => ctx.storage.getUrl(storageId));
      if (!url) throw new Error("Missing test evidence URL");
      evidenceByUrl.set(url, content);
      return { storageId, sha256: digest(content) };
    };
    const storeCompressedEvidence = async (
      value: unknown,
    ): Promise<{ storageId: Id<"_storage">; sha256: string }> => {
      const content = gzipSync(bytes(value), { level: 9 });
      const storageId = await t.run((ctx) =>
        ctx.storage.store(new Blob([content], { type: "application/gzip" })),
      );
      const url = await t.run((ctx) => ctx.storage.getUrl(storageId));
      if (!url) throw new Error("Missing compressed test evidence URL");
      evidenceByUrl.set(url, content);
      return { storageId, sha256: digest(content) };
    };
    const token = "test-decision-token";
    await t.run((ctx) =>
      ctx.db.insert("authTokens", {
        name: "test",
        value: token,
        createdAt: Date.now(),
      }),
    );
    const decision = {
      protocolVersion: 1,
      sourceCommit,
      sourceEvidence: {
        storageId: sourceStorageId,
        sha256: digest(sourceBytes),
      },
      sources: snapshot.banks.map((bank) => ({
        evalPath: bank.sourceEval,
        questions: bank.questions.map((question) => ({
          id: question.id,
          optionIds: question.options.map((option) => option.id),
          correctOptionId: question.correctOptionId,
        })),
      })),
    };
    await expect(
      t.action(api.decisionAdmin.mintBenchmark, {
        token: "wrong-token",
        version: snapshot.benchmark.version,
        evalCount: snapshot.benchmark.evalCount,
        curatedModels: [],
        decision,
      }),
    ).rejects.toThrow("Invalid authentication token");
    await t.action(api.decisionAdmin.mintBenchmark, {
      token,
      version: snapshot.benchmark.version,
      evalCount: snapshot.benchmark.evalCount,
      curatedModels: [],
      decision,
    });
    expect(sourceReads).toBe(1);

    const bank = snapshot.banks[0];
    const question = bank.questions[0];
    const questionKey = `${bank.sourceEval}/${question.id}`;
    const seed = "action-test-seed";
    const presented = presentQuestion(question, bank.sourceEval, seed, 0);
    const config = {
      provider: "openrouter" as const,
      model: "typesafe/jev-1.13",
      reasoningEffort: "low" as const,
      maxOutputTokens: 64,
      timeoutMs: 5_000,
      maxRetries: 0,
    };
    const request = buildProviderRequest(config, presented, "");
    const clientRunKey = randomUUID();
    const origin = { kind: "development" as const, sourceCommit };
    await expect(
      t.action(api.decisionAdmin.start, {
        token,
        clientRunKey: randomUUID(),
        benchmarkHash: snapshot.benchmark.version,
        model: config.model,
        condition: "no_guidelines",
        profile: {
          reasoningEffort: null,
          maxOutputTokens: null,
          timeoutMs: config.timeoutMs,
          maxRetries: 0,
          seed,
          repetitions: 1,
        },
        plannedQuestions: [questionKey],
        origin: {
          kind: "github_actions",
          repository: "get-convex/convex-evals",
          workflow:
            "get-convex/convex-evals/.github/workflows/decision_evals.yml@refs/heads/main",
          runId: "123",
          runAttempt: 1,
          ref: "refs/heads/main",
          sourceCommit,
        },
      }),
    ).rejects.toThrow("approved main workflow");
    const started = await t.action(api.decisionAdmin.start, {
      token,
      clientRunKey,
      benchmarkHash: snapshot.benchmark.version,
      model: config.model,
      condition: "no_guidelines",
      profile: {
        reasoningEffort: null,
        maxOutputTokens: null,
        timeoutMs: config.timeoutMs,
        maxRetries: 0,
        seed,
        repetitions: 1,
      },
      plannedQuestions: [questionKey],
      origin,
    });
    const attempt = {
      attempt: 1,
      startedAt: "2026-09-18T00:00:00.000Z",
      durationMs: 12,
      httpStatus: 200,
      response: {
        model: config.model,
        answers: {
          decision: {
            type: "choice",
            choice: "A",
            probabilities: { A: 1, B: 0, C: 0, D: 0 },
            confidence: 1,
          },
        },
        usage: { cost: 0 },
      },
      error: null,
    };
    const questionEvidence = {
      artifactVersion: 1,
      kind: "decision-question",
      runId: String(started.runId),
      key: `${questionKey}/0`,
      request,
      result: {
        key: `${questionKey}/0`,
        sourceEval: bank.sourceEval,
        repetition: 0,
        questionId: question.id,
        outcome: {
          kind: "answered",
          answer: null,
          error: null,
          attempts: [attempt],
          durationMs: 12,
        },
        selectedCanonicalId: "forged",
        expectedCanonicalId: "forged",
        correct: false,
      },
    };
    const questionBytes = bytes(questionEvidence);
    const questionStorageId = await t.run((ctx) =>
      ctx.storage.store(
        new Blob([questionBytes], { type: "application/json" }),
      ),
    );
    const questionUrl = await t.run((ctx) =>
      ctx.storage.getUrl(questionStorageId),
    );
    if (!questionUrl) throw new Error("Missing test question URL");
    evidenceByUrl.set(questionUrl, questionBytes);
    const questionDigest = digest(questionBytes);
    const tamperedQuestionEvidence = await storeEvidence({
      ...questionEvidence,
      request: { ...request, model: "tampered/model" },
    });
    await expect(
      t.action(api.decisionAdmin.record, {
        token,
        runId: started.runId,
        items: [
          { questionKey, repetition: 0, evidence: tamperedQuestionEvidence },
        ],
      }),
    ).rejects.toThrow("Provider request mismatch");
    expect(sourceReads).toBe(1);
    expect(
      await t.action(api.decisionAdmin.record, {
        token,
        runId: started.runId,
        items: [
          {
            questionKey,
            repetition: 0,
            evidence: { storageId: questionStorageId, sha256: questionDigest },
          },
        ],
      }),
    ).toEqual({ inserted: 1, unchanged: 0 });
    expect(sourceReads).toBe(1);

    const runEvidence = {
      artifactVersion: 1,
      kind: "decision-run",
      runId: String(started.runId),
      clientRunKey,
      origin,
      manifest: {
        artifactVersion: 1,
        scope: "development",
        benchmarkStatus: "minted",
        sourceCommit,
        benchmark: snapshot.benchmark,
        protocol: snapshot.protocol,
        config,
        condition: "no_guidelines",
        seed,
        repetitions: 1,
        planned: [
          {
            key: `${questionKey}/0`,
            sourceEval: bank.sourceEval,
            repetition: 0,
            question,
            presented,
          },
        ],
      },
      status: {
        kind: "completed",
        stopReason: null,
        requests: 1,
        knownCostUsd: 0,
      },
      finishedAt: "2026-09-18T00:00:01.000Z",
      durationMs: 20,
      resultEvidence: [
        {
          questionKey,
          repetition: 0,
          evidence: { storageId: questionStorageId, sha256: questionDigest },
        },
      ],
      attempts: [
        {
          key: `${questionKey}/0`,
          requestSha256: digest(canonicalJson(request)),
          ...attempt,
        },
      ],
      attemptStarts: [
        {
          key: `${questionKey}/0`,
          requestSha256: digest(canonicalJson(request)),
          attempt: 1,
          startedAt: attempt.startedAt,
        },
      ],
    };
    const localManifestEvidence = await storeCompressedEvidence({
      ...runEvidence,
      manifest: { ...runEvidence.manifest, scope: "local-only" },
    });
    await expect(
      t.action(api.decisionAdmin.finish, {
        token,
        runId: started.runId,
        evidence: localManifestEvidence,
      }),
    ).rejects.toThrow("Hosted manifest does not match");
    const tamperedRequestDigestEvidence = await storeCompressedEvidence({
      ...runEvidence,
      attempts: [{ ...runEvidence.attempts[0], requestSha256: "0".repeat(64) }],
    });
    await expect(
      t.action(api.decisionAdmin.finish, {
        token,
        runId: started.runId,
        evidence: tamperedRequestDigestEvidence,
      }),
    ).rejects.toThrow("request digest differs");
    const finalEvidence = await storeCompressedEvidence(runEvidence);
    const finished = await t.action(api.decisionAdmin.finish, {
      token,
      runId: started.runId,
      evidence: finalEvidence,
    });
    expect(sourceReads).toBe(1);
    expect(finished.status).toBe("completed");
    expect(finished.summary.completedQuestions).toBe(1);
    // The backend derives correctness from the shuffled map and raw response;
    // forged client grading fields above are ignored.
    expect(finished.summary.correctQuestions).toBe(
      presented.displayToCanonical.A === question.correctOptionId ? 1 : 0,
    );
  }, 30_000);
});
