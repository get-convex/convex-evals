import { createHash } from "crypto";
import { existsSync, readFileSync, readdirSync, type Dirent } from "fs";
import { join, relative, resolve, sep } from "path";
import { SYSTEM_PROMPT } from "./models/index.js";

/**
 * Bump this only when a shared runner or scoring change alters what a pass
 * means. Eval directories, guidelines, and the system prompt are hashed
 * automatically below.
 */
// One shared suite now includes coding and multiple-choice knowledge evals.
export const BENCHMARK_PROTOCOL_VERSION = "4";

export const BENCHMARK_DECISION_SOURCE_FILES = [
  "protocol.ts",
  "coverage.ts",
  "questions.ts",
  "providers.ts",
  "scoring.ts",
  "report.ts",
  "regrade.ts",
  "run.ts",
  "source.ts",
] as const;
export const BENCHMARK_DECISION_BACKEND_FILES = [
  "decisionAdmin.ts",
  "decisionConfig.ts",
  "decisionScoring.ts",
  "decisionIdentity.ts",
  "decisionIngestionPerformance.ts",
  "decisionSourceValidation.ts",
  "decisionStorage.ts",
  "documentKinds.ts",
] as const;

export interface BenchmarkDefinition {
  version: string;
  evalCount: number;
}

const EXCLUDED_DIRECTORIES = new Set([
  "node_modules",
  "_generated",
  "__pycache__",
]);

/** Old answer folders include local backend state. These are runtime outputs,
 * not benchmark inputs, just like node_modules and generated API files. */
export function isBenchmarkRuntimeArtifact(name: string): boolean {
  return (
    name === ".DS_Store" ||
    /^backend\.(?:stdout|stderr)\.log$/.test(name) ||
    /^convex_local_backend\.sqlite3(?:-wal|-shm)?$/.test(name)
  );
}

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
    if (entry.isFile() && isBenchmarkRuntimeArtifact(entry.name)) continue;

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

  // Decision questions live alongside TASK.txt and are hashed below. Include
  // request/scoring semantics in this same shared identity, never a second
  // decision-only benchmark. Missing files are allowed for historical fixtures.
  for (const file of BENCHMARK_DECISION_SOURCE_FILES) {
    const sourcePath = join(absoluteRoot, "runner", "decisions", file);
    if (existsSync(sourcePath)) {
      hasher.update(`decision-source\0${file}\0`);
      hasher.update(readFileSync(sourcePath));
      hasher.update("\0");
    }
  }

  for (const file of BENCHMARK_DECISION_BACKEND_FILES) {
    const sourcePath = join(absoluteRoot, "evalScores", "convex", file);
    if (existsSync(sourcePath)) {
      hasher.update(`decision-backend\0${file}\0`);
      hasher.update(readFileSync(sourcePath));
      hasher.update("\0");
    }
  }

  const decisionManifest = join(absoluteRoot, "decision-bank.json");
  if (existsSync(decisionManifest)) {
    hasher.update("decision-coverage\0");
    hasher.update(readFileSync(decisionManifest));
    hasher.update("\0");
  }

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
