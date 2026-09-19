#!/usr/bin/env bun
import { Command, Option } from "commander";
import { resolve } from "node:path";
import { loadQuestionBanks } from "./questions.js";
import { runDecisions, type DecisionRunOptions } from "./run.js";
import { writeReport } from "./report.js";
import { regradeRun } from "./regrade.js";
import { readDecisionDefinition } from "./coverage.js";
import { z } from "zod";

const inspectOptionsSchema = z.object({
  root: z.string(),
  allowPartial: z.boolean().optional(),
});
const runOptionsSchema = z.object({
  root: z.string(),
  output: z.string(),
  provider: z.enum(["typesafe", "openrouter"]),
  model: z.string(),
  condition: z.enum(["no_guidelines", "with_guidelines"]),
  reasoning: z.enum(["low", "medium", "high"]),
  filter: z.string().optional(),
  envFile: z.string().optional(),
  limitEvals: z.number(),
  repetitions: z.number(),
  seed: z.string(),
  maxRequests: z.number(),
  maxKnownCostUsd: z.number(),
  maxOutputTokens: z.number(),
  timeoutMs: z.number(),
  maxRetries: z.number(),
});
const regradeOptionsSchema = z.object({
  root: z.string(),
  output: z.string(),
  reason: z.string(),
});

const program = new Command()
  .name("decisions")
  .description(
    "Local Convex multiple-choice evals. No Convex writes, deployments, or benchmark minting.",
  );
for (const name of ["list", "validate"] as const) {
  program
    .command(name)
    .option("--root <directory>", "Project root", ".")
    .option("--allow-partial", "Allow missing banks during authoring")
    .action((input: unknown) => {
      const options = inspectOptionsSchema.parse(input);
      const inventory = loadQuestionBanks(resolve(options.root));
      const coverage = readDecisionDefinition(resolve(options.root), inventory);
      const errors = [...inventory.errors, ...coverage.errors];
      console.log(
        JSON.stringify(
          name === "list"
            ? {
                sourceEvals: inventory.sourceEvalCount,
                questions: inventory.questionCount,
                evals: inventory.banks.map((bank) => ({
                  id: bank.sourceEval,
                  questions: bank.questions.length,
                })),
                missing: inventory.missing,
                reviewedCoverage: coverage.definition,
                errors,
              }
            : {
                sourceEvals: inventory.sourceEvalCount,
                convertedEvals: inventory.banks.length,
                questions: inventory.questionCount,
                missing: inventory.missing,
                reviewedCoverage: coverage.definition,
                errors,
              },
          null,
          2,
        ),
      );
      if (errors.length || (!options.allowPartial && !coverage.definition))
        process.exitCode = 1;
    });
}
for (const command of ["run", "dry-run"] as const) {
  program
    .command(command)
    .addOption(
      new Option("--provider <provider>", "Provider adapter")
        .choices(["typesafe", "openrouter"])
        .default("typesafe"),
    )
    .requiredOption(
      "--model <id>",
      "Exact provider model ID, or an explicitly recorded alias",
    )
    .option("--root <directory>", "Project root", ".")
    .option("--output <directory>", "Local output parent", "output-decisions")
    .option(
      "--env-file <path>",
      "Read only the selected provider key from this local file",
    )
    .option("--filter <regex>", "Filter source eval IDs")
    .option("--limit-evals <n>", "Maximum source evals", Number, 8)
    .option(
      "--repetitions <n>",
      "Matched option permutations per question",
      Number,
      1,
    )
    .option(
      "--seed <value>",
      "Shared permutation seed",
      "convex-choice-pilot-v1",
    )
    .addOption(
      new Option("--condition <condition>", "Global guideline condition")
        .choices(["no_guidelines", "with_guidelines"])
        .default("no_guidelines"),
    )
    .addOption(
      new Option("--reasoning <effort>", "LLM reasoning effort")
        .choices(["low", "medium", "high"])
        .default("low"),
    )
    .option(
      "--max-output-tokens <n>",
      "LLM output and reasoning budget",
      Number,
      2048,
    )
    .option(
      "--max-requests <n>",
      "Hard request cap including retries",
      Number,
      50,
    )
    .option(
      "--max-known-cost-usd <n>",
      "Stop after this observed spend; unknown cost is still subject to request cap",
      Number,
      1,
    )
    .option("--timeout-ms <n>", "Per-request timeout", Number, 45000)
    .option(
      "--max-retries <n>",
      "Retries after transport/transient HTTP errors only",
      Number,
      1,
    )
    .action(async (input: unknown) => {
      const options = runOptionsSchema.parse(input);
      const runOptions: DecisionRunOptions = {
        projectRoot: options.root,
        outputRoot: options.output,
        condition: options.condition,
        filter: options.filter,
        limitEvals: options.limitEvals,
        repetitions: options.repetitions,
        seed: options.seed,
        maxRequests: options.maxRequests,
        maxKnownCostUsd: options.maxKnownCostUsd,
        envFile: options.envFile,
        dryRun: command === "dry-run",
        config: {
          provider: options.provider,
          model: options.model,
          reasoningEffort: options.reasoning,
          maxOutputTokens: options.maxOutputTokens,
          timeoutMs: options.timeoutMs,
          maxRetries: options.maxRetries,
        },
      };
      const result = await runDecisions(runOptions);
      console.log(JSON.stringify(result, null, 2));
      if (!result.dryRun && !result.summary?.complete) process.exitCode = 1;
    });
}
program
  .command("report <directory>")
  .description(
    "Recompute a local report from saved artifacts, with no API calls",
  )
  .action((directory: unknown) =>
    console.log(
      JSON.stringify(
        writeReport(resolve(z.string().parse(directory))),
        null,
        2,
      ),
    ),
  );

program
  .command("regrade <directory>")
  .description(
    "Reparse saved responses into a new local report, with no API calls",
  )
  .option("--root <directory>", "Current project root", ".")
  .option(
    "--output <directory>",
    "Local output parent",
    "output-decisions-regraded",
  )
  .requiredOption("--reason <text>", "Reason for revised grading")
  .action((directory: unknown, input: unknown) => {
    const options = regradeOptionsSchema.parse(input);
    console.log(
      JSON.stringify(
        regradeRun(
          z.string().parse(directory),
          options.root,
          options.output,
          options.reason,
        ),
        null,
        2,
      ),
    );
  });

if (import.meta.main) {
  program.parseAsync().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
