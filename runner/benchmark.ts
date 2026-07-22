import { createHash } from "crypto";
import { existsSync, readFileSync, readdirSync, type Dirent } from "fs";
import { join, relative, resolve, sep } from "path";
import { SYSTEM_PROMPT } from "./models/index.js";

/**
 * Bump this only when a shared runner or scoring change alters what a pass
 * means. Eval directories, guidelines, and the system prompt are hashed
 * automatically below.
 */
export const BENCHMARK_PROTOCOL_VERSION = "1";

export interface BenchmarkDefinition {
  version: string;
  evalCount: number;
}

const EXCLUDED_DIRECTORIES = new Set([
  "node_modules",
  "_generated",
  "__pycache__",
]);

function normalizedPath(path: string): string {
  return path.split(sep).join("/");
}

function hashDirectory(
  hasher: ReturnType<typeof createHash>,
  projectRoot: string,
  directory: string,
): void {
  const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  for (const entry of entries) {
    if (entry.isDirectory() && EXCLUDED_DIRECTORIES.has(entry.name)) continue;

    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      hashDirectory(hasher, projectRoot, fullPath);
      continue;
    }

    hasher.update(normalizedPath(relative(projectRoot, fullPath)));
    hasher.update("\0");
    hasher.update(readFileSync(fullPath));
    hasher.update("\0");
  }
}

/**
 * Compute the public benchmark identity from the complete, unfiltered suite.
 * A filtered/manual run still carries this identity, but the backend marks it
 * ineligible for leaderboard aggregation.
 */
export function computeBenchmarkDefinition(
  evalPaths: string[],
  projectRoot = process.cwd(),
): BenchmarkDefinition {
  const absoluteRoot = resolve(projectRoot);
  const sortedEvalPaths = [...new Set(evalPaths.map(normalizedPath))].sort();
  const guidelinesPath = join(
    absoluteRoot,
    "runner",
    "models",
    "guidelines.md",
  );

  if (!existsSync(guidelinesPath)) {
    throw new Error(
      `Cannot compute benchmark version: missing ${guidelinesPath}`,
    );
  }

  const hasher = createHash("sha256");
  hasher.update(`protocol\0${BENCHMARK_PROTOCOL_VERSION}\0`);
  hasher.update(`system-prompt\0${SYSTEM_PROMPT}\0`);
  hasher.update("guidelines\0");
  hasher.update(readFileSync(guidelinesPath));
  hasher.update("\0");

  for (const evalPath of sortedEvalPaths) {
    const absoluteEvalPath = resolve(absoluteRoot, evalPath);
    if (!existsSync(absoluteEvalPath)) {
      throw new Error(
        `Cannot compute benchmark version: missing eval directory ${absoluteEvalPath}`,
      );
    }
    hasher.update(`eval\0${evalPath}\0`);
    hashDirectory(hasher, absoluteRoot, absoluteEvalPath);
  }

  return {
    version: hasher.digest("hex"),
    evalCount: sortedEvalPaths.length,
  };
}

function childDirectories(path: string): Dirent[] {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function discoverBenchmarkEvalPaths(
  projectRoot = process.cwd(),
): string[] {
  const evalsRoot = join(projectRoot, "evals");
  const paths: string[] = [];

  for (const category of childDirectories(evalsRoot)) {
    const categoryPath = join(evalsRoot, category.name);
    for (const evalDirectory of childDirectories(categoryPath)) {
      const taskPath = join(categoryPath, evalDirectory.name, "TASK.txt");
      if (!existsSync(taskPath)) continue;
      paths.push(
        normalizedPath(join("evals", category.name, evalDirectory.name)),
      );
    }
  }

  return paths;
}
