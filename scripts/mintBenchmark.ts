#!/usr/bin/env bun
import "dotenv/config";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { api } from "../evalScores/convex/_generated/api.js";
import {
  computeBenchmarkDefinition,
  discoverBenchmarkEvalPaths,
} from "../runner/benchmark.js";
import { ALL_MODELS } from "../runner/models/index.js";
import {
  createDecisionSourceSnapshot,
  sha256,
} from "../runner/decisions/source.js";
import { decisionReportingTarget } from "../runner/decisions/reporting.js";

async function main(): Promise<void> {
  const kind = process.env.BENCHMARK_KIND;
  if (kind !== "coding" && kind !== "decision")
    throw new Error("BENCHMARK_KIND must explicitly be coding or decision");
  const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  const target = decisionReportingTarget(
    process.env,
    sourceCommit,
    process.env.BENCHMARK_MINT_TARGET === "development" ? "development" : "ci",
  );
  if (!target) {
    console.log("Benchmark reporting disabled; no mint or upload performed");
    return;
  }
  if (
    target.origin.kind === "github_actions" &&
    !target.origin.workflow.includes("/mint_benchmark.yml@")
  )
    throw new Error("Use the manual benchmark mint workflow");
  const client = new ConvexHttpClient(target.url);
  const coding = computeBenchmarkDefinition(discoverBenchmarkEvalPaths());
  if (kind === "coding") {
    await client.mutation(api.admin.mintBenchmark, {
      token: target.token,
      ...coding,
      curatedModels: ALL_MODELS,
    });
    console.log(
      `Minted coding benchmark ${coding.version} (${coding.evalCount} evals)`,
    );
    return;
  }
  const snapshot = createDecisionSourceSnapshot(process.cwd(), sourceCommit);
  const definition = snapshot.benchmark;
  const bytes = JSON.stringify(snapshot) + "\n";
  const digest = sha256(bytes);
  mkdirSync("output-benchmark-mint", { recursive: true, mode: 0o700 });
  writeFileSync(`output-benchmark-mint/${digest}.json`, bytes, { mode: 0o600 });
  const uploadUrl = await client.mutation(api.admin.generateUploadUrl, {
    token: target.token,
  });
  const response = await fetch(uploadUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: bytes,
  });
  if (!response.ok)
    throw new Error(`Source upload failed (HTTP ${response.status})`);
  const uploaded = (await response.json()) as { storageId?: unknown };
  if (typeof uploaded.storageId !== "string")
    throw new Error("Source upload returned no storage ID");
  await client.action(
    makeFunctionReference<"action">("decisionAdmin:mintBenchmark"),
    {
      token: target.token,
      version: definition.version,
      identityFormat: "decision_v1",
      codingBenchmarkVersionHash: coding.version,
      evalCount: definition.evalCount,
      curatedModels: ALL_MODELS,
      decision: {
        protocolVersion: snapshot.protocol.version,
        sourceCommit,
        sourceEvidence: { storageId: uploaded.storageId, sha256: digest },
        sources: snapshot.banks.map((bank) => ({
          evalPath: bank.sourceEval,
          questions: bank.questions.map((question) => ({
            id: question.id,
            optionIds: question.options.map((option) => option.id),
            correctOptionId: question.correctOptionId,
          })),
        })),
      },
    },
  );

  console.log(
    `Minted decision benchmark ${definition.version.slice(0, 12)} (${definition.evalCount} coding evals, ${snapshot.banks.length} decision sources, ${snapshot.banks.reduce((sum, bank) => sum + bank.questions.length, 0)} questions)`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
