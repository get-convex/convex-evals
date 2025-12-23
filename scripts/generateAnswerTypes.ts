#!/usr/bin/env bun
/**
 * Generates _generated types for all answer directories in evals.
 * Run with: bun run scripts/generateAnswerTypes.ts
 */

import { readdir, stat, rm } from "fs/promises";
import { join } from "path";
import { $ } from "bun";

const EVALS_DIR = "evals";

async function findAnswerDirs(dir: string): Promise<string[]> {
  const answerDirs: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const fullPath = join(dir, entry.name);

    if (entry.name === "answer") {
      // Check if this answer dir has a convex folder
      const convexPath = join(fullPath, "convex");
      try {
        const convexStat = await stat(convexPath);
        if (convexStat.isDirectory()) {
          answerDirs.push(fullPath);
        }
      } catch {
        // No convex folder, skip
      }
    } else if (entry.name !== "node_modules" && entry.name !== "_generated") {
      // Recurse into subdirectories
      const subDirs = await findAnswerDirs(fullPath);
      answerDirs.push(...subDirs);
    }
  }

  return answerDirs;
}

async function isEmptyDir(dirPath: string): Promise<boolean> {
  try {
    const entries = await readdir(dirPath);
    return entries.length === 0;
  } catch {
    return false;
  }
}

async function generateTypes(answerDir: string): Promise<boolean> {
  const relativePath = answerDir.replace(/\\/g, "/");
  process.stdout.write(`Generating types for ${relativePath}... `);

  try {
    // Check if _generated folder exists and is empty - if so, remove it
    // (empty _generated folder causes codegen to fail)
    const generatedPath = join(answerDir, "convex", "_generated");
    if (await isEmptyDir(generatedPath)) {
      await rm(generatedPath, { recursive: true, force: true });
    }

    // First install dependencies
    await $`bun install`.cwd(answerDir).quiet();

    // Then run codegen
    await $`bunx convex codegen --typecheck disable --init`
      .cwd(answerDir)
      .quiet();

    console.log("✓");
    return true;
  } catch (error) {
    console.log("✗");
    console.error(`  Error: ${error}`);
    return false;
  }
}

async function main() {
  console.log("Finding answer directories...\n");

  const answerDirs = await findAnswerDirs(EVALS_DIR);
  answerDirs.sort();

  console.log(`Found ${answerDirs.length} answer directories\n`);

  let succeeded = 0;
  let failed = 0;

  for (const dir of answerDirs) {
    const success = await generateTypes(dir);
    if (success) {
      succeeded++;
    } else {
      failed++;
    }
  }

  console.log(`\nDone! ${succeeded} succeeded, ${failed} failed`);

  if (failed > 0) {
    process.exit(1);
  }
}

main();
