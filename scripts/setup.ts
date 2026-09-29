#!/usr/bin/env bun
/**
 * Prepares a fresh checkout or worktree for typecheck, tests and local runs.
 * Run with: bun run setup
 *
 * Runs before node_modules exists, so it imports only Bun and Node built-ins.
 */
import { $ } from "bun";
import { access, copyFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");

// Matches the install steps in .github/workflows/pr_checks.yml.
const installDirs = [".", "evalScores", "visualizer"];

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function listWorktrees(root: string): Promise<string[]> {
  const { stdout, exitCode } = await $`git worktree list --porcelain`
    .cwd(root)
    .nothrow()
    .quiet();
  if (exitCode !== 0) {
    return [];
  }

  return stdout
    .toString()
    .split(/\r?\n/)
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length).trim());
}

export async function copyEnvFromSiblingWorktree(
  root: string = repoRoot,
): Promise<void> {
  const target = join(root, ".env");
  if (await fileExists(target)) {
    return;
  }

  for (const worktree of await listWorktrees(root)) {
    const source = join(worktree, ".env");
    if (!(await fileExists(source))) {
      continue;
    }

    await copyFile(source, target);
    console.log(`[setup] copied ignored .env from ${worktree}`);
    return;
  }

  console.warn("[setup] no sibling .env found; API keys may need manual setup");
}

async function main(): Promise<void> {
  for (const dir of installDirs) {
    const label = dir === "." ? "root" : dir;
    console.log(`[setup] Installing ${label} dependencies`);
    await $`bun install --frozen-lockfile`.cwd(join(repoRoot, dir));
  }

  await copyEnvFromSiblingWorktree();
  await $`bun run setup:convex`.cwd(repoRoot);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
