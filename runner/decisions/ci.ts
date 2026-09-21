#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { runDecisions } from "./run.js";
import {
  createDecisionReporter,
  decisionReportingTarget,
  decisionTransport,
} from "./reporting.js";
import type { DecisionProvider } from "./protocol.js";

export const DECISION_CI_MODELS = {
  jev: { provider: "openrouter", model: "typesafe/jev-1.13" },
  luna: { provider: "openrouter", model: "openai/gpt-5.6-luna" },
  sol: { provider: "openrouter", model: "openai/gpt-5.6-sol" },
  astra: { provider: "openrouter", model: "openai/gpt-6-astra" },
  grok47: { provider: "openrouter", model: "x-ai/grok-4.7" },
} satisfies Record<string, { provider: DecisionProvider; model: string }>;

async function main(): Promise<void> {
  const key = process.env.DECISION_MODEL;
  if (!key || !(key in DECISION_CI_MODELS))
    throw new Error(
      `DECISION_MODEL must be one of: ${Object.keys(DECISION_CI_MODELS).join(", ")}`,
    );
  const root = process.cwd();
  const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const target = decisionReportingTarget(process.env, sourceCommit);
  if (!target)
    throw new Error(
      "Hosted decision workflow cannot run with reporting disabled; use the local decisions command",
    );
  if (
    target.origin.kind !== "github_actions" ||
    !target.origin.workflow.includes("/decision_evals.yml@")
  )
    throw new Error("Use the decision eval workflow to start inference");
  const condition = process.env.DECISION_CONDITION ?? "no_guidelines";
  if (condition !== "no_guidelines" && condition !== "with_guidelines")
    throw new Error("Invalid decision condition");
  const model = DECISION_CI_MODELS[key as keyof typeof DECISION_CI_MODELS];
  const transport = await decisionTransport(target.url);
  const hooks = createDecisionReporter(target, randomUUID(), transport);
  const result = await runDecisions(
    {
      projectRoot: root,
      outputRoot: resolve(process.env.DECISION_OUTPUT ?? "output-decisions-ci"),
      config: {
        ...model,
        reasoningEffort: "low",
        maxOutputTokens: 2048,
        timeoutMs: 45000,
        maxRetries: 1,
      },
      condition,
      limitEvals: 10000,
      repetitions: 3,
      seed: "convex-decision-release-v1",
      maxRequests: 636,
      maxKnownCostUsd: 5,
      dryRun: false,
    },
    {},
    hooks,
  );
  console.log(JSON.stringify(result, null, 2));
  if (!result.summary?.complete) process.exitCode = 1;
}

if (import.meta.main)
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
