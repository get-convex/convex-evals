#!/usr/bin/env bun
/**
 * Build release: generates Convex coding guidelines/rules files
 * in multiple formats for different AI coding assistants.
 */
import { mkdirSync, writeFileSync } from "fs";
import { execFileSync } from "node:child_process";
import { encode } from "gpt-tokenizer/encoding/cl100k_base";
import { buildReleaseRules } from "./runner/models/modelCodegen.js";
import { loadQuestionBanks } from "./runner/decisions/questions.js";

const MDC_FRONTMATTER = `---
description: Guidelines and best practices for building Convex projects, including database schema design, queries, mutations, and real-world examples
globs: **/*.ts,**/*.tsx,**/*.js,**/*.jsx
---

`;

const GITHUB_COPILOT_FRONTMATTER = `---
applyTo: "**/*.ts,**/*.tsx,**/*.js,**/*.jsx"
---

`;

function main(): void {
  mkdirSync("dist", { recursive: true });
  const rules = buildReleaseRules();

  writeFileSync("dist/anthropic_convex_rules.txt", rules);
  writeFileSync("dist/openai_convex_rules.txt", rules);
  writeFileSync("dist/anthropic_convex_rules.mdc", MDC_FRONTMATTER + rules);
  writeFileSync("dist/openai_convex_rules.mdc", MDC_FRONTMATTER + rules);
  writeFileSync("dist/convex_rules.txt", rules);
  writeFileSync("dist/convex_rules.mdc", MDC_FRONTMATTER + rules);
  writeFileSync(
    "dist/convex.instructions.md",
    GITHUB_COPILOT_FRONTMATTER + rules,
  );

  writeFileSync("dist/AGENTS.md", rules);
  const agentsTokens = encode(rules).length;
  console.log(`dist/AGENTS.md: ${agentsTokens} tokens`);

  // A standalone archive keeps the evidence and replay entrypoints available
  // without the original author's workspace or installed dependencies.
  const inventory = loadQuestionBanks();
  if (inventory.errors.length) throw new Error(inventory.errors.join("\n"));
  execFileSync(process.execPath, ["verification/decisions/verify.mjs"], {
    stdio: "inherit",
  });
  execFileSync("tar", [
    "-czf",
    "dist/decision-verification.tgz",
    "verification/decisions",
    "decision-bank.json",
    "docs/decision-question-authoring.md",
    "docs/decision-verification.md",
    ...inventory.banks.map((bank) => `evals/${bank.sourceEval}/questions.json`),
  ]);
  console.log(
    `dist/decision-verification.tgz: ${inventory.questionCount} questions with archived evidence`,
  );
}

main();
