#!/usr/bin/env bun
/**
 * Run the no-guidelines eval suite through a native coding-agent harness.
 *
 * Each cell uses a fresh isolated directory. Results are checkpointed after
 * every eval, so a provider quota or machine restart can be resumed safely.
 *
 * Usage:
 *   EVALS_NATIVE_HARNESS=codex \
 *   NATIVE_RESULTS_DIR=/path/to/results \
 *   bun run scripts/runNativeHarnessMatrix.ts
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { runEvalsForModel } from "../runner/index.js";
import {
  resolveModelDefaults,
  type ResolvedModel,
} from "../runner/models/index.js";
import type { EvalIndividualResult } from "../runner/reporting.js";
import type {
  NativeHarnessConfig,
  NativeHarnessName,
} from "../runner/models/nativeHarness.js";

type MatrixCell = {
  evalPath: string;
  model: string;
  webSearch: boolean;
};

type SavedCell = MatrixCell & {
  recordedAt: string;
  result: EvalIndividualResult;
};

type MatrixResults = {
  version: 1;
  startedAt: string;
  updatedAt: string;
  sourceCommit: string;
  harness: NativeHarnessName;
  cliVersion: string;
  plannedEvals: string[];
  models: string[];
  cells: Record<string, SavedCell>;
};

const HARNESS_MODELS: Record<NativeHarnessName, string[]> = {
  codex: ["openai/gpt-5.6-sol", "openai/gpt-5.6-luna"],
  claude: ["anthropic/claude-opus-5", "anthropic/claude-sonnet-5"],
  grok: ["x-ai/grok-4.6", "x-ai/grok-4.5"],
};

function parseHarness(): NativeHarnessName {
  const value = process.env.EVALS_NATIVE_HARNESS;
  if (value === "codex" || value === "claude" || value === "grok") {
    return value;
  }
  throw new Error("Set EVALS_NATIVE_HARNESS to codex, claude, or grok");
}

function discoverEvalPaths(): string[] {
  const paths: string[] = [];
  for (const category of readdirSync("evals", { withFileTypes: true })) {
    if (!category.isDirectory()) continue;
    const categoryPath = join("evals", category.name);
    for (const evalDir of readdirSync(categoryPath, {
      withFileTypes: true,
    })) {
      if (!evalDir.isDirectory()) continue;
      const evalPath = `${category.name}/${evalDir.name}`;
      if (existsSync(join(categoryPath, evalDir.name, "TASK.txt"))) {
        paths.push(evalPath);
      }
    }
  }

  const filter = process.env.TEST_FILTER
    ? new RegExp(process.env.TEST_FILTER)
    : undefined;
  return paths.sort().filter((path) => !filter || filter.test(path));
}

function cellKey(cell: MatrixCell): string {
  return `${cell.model}|${cell.webSearch ? "web" : "no-web"}|${cell.evalPath}`;
}

function exactFilter(evalPath: string): RegExp {
  return new RegExp(`^${evalPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
}

function modelForRun(name: string): ResolvedModel {
  return {
    ...resolveModelDefaults(name),
    formattedName: name,
  };
}

function cliVersion(harness: NativeHarnessName): string {
  return execFileSync(harness, ["--version"], { encoding: "utf8" }).trim();
}

function gitCommit(): string {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
}

function readOrCreateResults(
  resultsPath: string,
  harness: NativeHarnessName,
  plannedEvals: string[],
  models: string[],
): MatrixResults {
  if (existsSync(resultsPath)) {
    const saved = JSON.parse(
      readFileSync(resultsPath, "utf8"),
    ) as MatrixResults;
    if (saved.harness !== harness) {
      throw new Error(
        `Results file belongs to ${saved.harness}, not ${harness}`,
      );
    }
    const currentCommit = gitCommit();
    if (saved.sourceCommit !== currentCommit) {
      throw new Error(
        `Results were started at ${saved.sourceCommit}, but the current commit is ${currentCommit}`,
      );
    }
    if (JSON.stringify(saved.plannedEvals) !== JSON.stringify(plannedEvals)) {
      throw new Error("The saved eval plan does not match the current filter");
    }
    if (JSON.stringify(saved.models) !== JSON.stringify(models)) {
      throw new Error("The saved model plan does not match the current matrix");
    }
    return saved;
  }

  const now = new Date().toISOString();
  return {
    version: 1,
    startedAt: now,
    updatedAt: now,
    sourceCommit: gitCommit(),
    harness,
    cliVersion: cliVersion(harness),
    plannedEvals,
    models,
    cells: {},
  };
}

function saveResults(resultsPath: string, results: MatrixResults): void {
  results.updatedAt = new Date().toISOString();
  mkdirSync(dirname(resultsPath), { recursive: true });
  const temporaryPath = `${resultsPath}.tmp`;
  writeFileSync(temporaryPath, JSON.stringify(results, null, 2), "utf8");
  renameSync(temporaryPath, resultsPath);
}

function orderedCells(
  evalPath: string,
  evalIndex: number,
  models: string[],
): MatrixCell[] {
  const cells = models.flatMap((model) => [
    { evalPath, model, webSearch: false },
    { evalPath, model, webSearch: true },
  ]);

  // Balance which condition and model runs first as the matrix progresses.
  const rotation = evalIndex % cells.length;
  return [...cells.slice(rotation), ...cells.slice(0, rotation)];
}

function isRateLimitResult(result: EvalIndividualResult): boolean {
  return result.failure_reason?.toLowerCase().includes("rate_limit") ?? false;
}

function isHarnessInfrastructureFailure(result: EvalIndividualResult): boolean {
  return Object.keys(result.scores).length === 0;
}

async function runCell(
  harness: NativeHarnessName,
  cell: MatrixCell,
): Promise<EvalIndividualResult> {
  const tempdir = mkdtempSync(
    join(tmpdir(), `convex-native-matrix-${harness}-`),
  );
  const config: NativeHarnessConfig = {
    name: harness,
    webSearch: cell.webSearch,
  };

  try {
    const results = await runEvalsForModel({
      model: modelForRun(cell.model),
      provider: `native-${harness}`,
      tempdir,
      testFilter: exactFilter(cell.evalPath),
      experiment: "no_guidelines",
      nativeHarness: config,
    });
    if (results.length !== 1) {
      throw new Error(
        `Expected one result for ${cell.evalPath}, received ${results.length}`,
      );
    }
    return {
      ...results[0],
      // The generated project is removed below to keep the 1,332-cell matrix
      // from consuming hundreds of gigabytes of local disk.
      directory_path: null,
    };
  } finally {
    rmSync(tempdir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const harness = parseHarness();
  const models = HARNESS_MODELS[harness];
  const plannedEvals = discoverEvalPaths();
  const resultsDir = process.env.NATIVE_RESULTS_DIR;
  if (!resultsDir) {
    throw new Error("Set NATIVE_RESULTS_DIR to a durable output directory");
  }
  const resultsPath = resolve(resultsDir, `${harness}.json`);
  const saved = readOrCreateResults(resultsPath, harness, plannedEvals, models);
  saveResults(resultsPath, saved);

  console.log(
    `[native-matrix] ${harness}: ${plannedEvals.length} evals, ${models.length} models, web on/off`,
  );
  console.log(`[native-matrix] checkpoint: ${resultsPath}`);

  for (const [evalIndex, evalPath] of plannedEvals.entries()) {
    for (const cell of orderedCells(evalPath, evalIndex, models)) {
      const key = cellKey(cell);
      if (saved.cells[key]) continue;

      console.log(
        `[native-matrix] ${harness} ${cell.model} ${cell.webSearch ? "web" : "no-web"} ${cell.evalPath}`,
      );
      const result = await runCell(harness, cell);
      if (isRateLimitResult(result)) {
        throw new Error(
          `Provider rate limit reached for ${cell.model}. Resume this command after the quota resets.`,
        );
      }
      if (isHarnessInfrastructureFailure(result)) {
        throw new Error(
          `Native harness failed before scoring ${cell.model} on ${cell.evalPath}: ${result.failure_reason}`,
        );
      }

      saved.cells[key] = {
        ...cell,
        recordedAt: new Date().toISOString(),
        result,
      };
      saveResults(resultsPath, saved);
    }
  }

  console.log(
    `[native-matrix] ${harness} complete: ${Object.keys(saved.cells).length} cells`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
