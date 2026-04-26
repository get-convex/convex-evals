/**
 * Scoring pipeline: writes generated files, installs deps, deploys, typechecks,
 * lints, and runs tests against a local Convex backend.
 */
import {
  mkdirSync,
  existsSync,
  writeFileSync,
  readdirSync,
  readFileSync,
} from "fs";
import { join, resolve, relative } from "path";
import { tmpdir } from "os";
import { $ } from "bun";
import {
  withConvexBackend,
  ADMIN_KEY,
  InfrastructureError,
  type ConvexBackend,
} from "./convexBackend.js";
import {
  appendLog,
  logInfo,
  logVitestResults,
  runCommandStep,
} from "./logging.js";
import { recordStep, completeEval, uploadEvalOutput } from "./reporting.js";
import type { LanguageModelUsage } from "ai";

// ── Timeout constants (ms) ───────────────────────────────────────────

const TIMEOUTS = {
  bunInstall: 60_000,
  codegen: 60_000,
  tsc: 60_000,
  eslint: 60_000,
  deploy: 90_000,
  vitest: 120_000,
} as const;

const DEFAULT_CONVEX_TSCONFIG = `${JSON.stringify(
  {
    compilerOptions: {
      allowJs: true,
      strict: true,
      moduleResolution: "Bundler",
      jsx: "react-jsx",
      skipLibCheck: true,
      allowSyntheticDefaultImports: true,
      target: "ESNext",
      lib: ["ES2021", "dom"],
      forceConsistentCasingInFileNames: true,
      module: "ESNext",
      isolatedModules: true,
      noEmit: true,
    },
    include: ["./**/*"],
    exclude: ["./_generated"],
  },
  null,
  2,
)}\n`;

/** Race a promise against a timeout. */
async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms / 1000}s`)),
      ms,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

// ── Types ─────────────────────────────────────────────────────────────

export interface ScoreResult {
  name: string;
  score: number;
}

type StepName =
  | "filesystem"
  | "install"
  | "deploy"
  | "tsc"
  | "eslint"
  | "tests";

export function isInfrastructureStepFailure(
  stepName: StepName,
  error: string | undefined,
): boolean {
  if (!error) return false;

  const lower = error.toLowerCase();
  if (stepName === "install") {
    return isEnvironmentFailure(lower);
  }
  if (stepName === "deploy") {
    return isEnvironmentFailure(lower) || lower.includes("convex dev timed out");
  }
  if (stepName === "tsc") {
    return isEnvironmentFailure(lower);
  }
  return false;
}

function isEnvironmentFailure(lowerError: string): boolean {
  return (
    lowerError.includes("timed out after") ||
    lowerError.includes("econnrefused") ||
    lowerError.includes("econnreset") ||
    lowerError.includes("etimedout") ||
    lowerError.includes("enotfound") ||
    lowerError.includes("eai_again") ||
    lowerError.includes("too many requests") ||
    lowerError.includes("rate limit") ||
    lowerError.includes("rate_limit") ||
    lowerError.includes("status code 429") ||
    lowerError.includes("http 429")
  );
}

export function getTypecheckTargets(projectDir: string): string[] {
  const convexDir = resolve(join(projectDir, "convex"));
  const rootTsconfig = resolve(join(projectDir, "tsconfig.json"));
  const convexTsconfig = resolve(join(convexDir, "tsconfig.json"));

  if (existsSync(rootTsconfig) && existsSync(convexTsconfig)) {
    return [rootTsconfig, convexTsconfig];
  }
  if (existsSync(rootTsconfig)) return [rootTsconfig];
  if (existsSync(convexTsconfig)) return [convexTsconfig];
  return [convexDir];
}

export function ensureConvexTsconfig(projectDir: string): void {
  const convexDir = resolve(join(projectDir, "convex"));
  const rootTsconfig = resolve(join(projectDir, "tsconfig.json"));
  const convexTsconfig = resolve(join(convexDir, "tsconfig.json"));

  if (
    !existsSync(convexDir) ||
    existsSync(rootTsconfig) ||
    existsSync(convexTsconfig)
  ) {
    return;
  }

  writeFileSync(convexTsconfig, DEFAULT_CONVEX_TSCONFIG, "utf-8");
}

// ── Scoring context ───────────────────────────────────────────────────

/** Encapsulates state shared across all scoring steps for one eval. */
class ScoringContext {
  readonly scores: ScoreResult[] = [];
  readonly evalPrefix: string;
  readonly runLogPath: string;
  private readonly evalStartTime = Date.now();
  private readonly stepResults = new Map<StepName, boolean>();

  constructor(
    readonly category: string,
    readonly name: string,
    readonly evalId: string | undefined,
    readonly outputProjectDir: string,
    readonly usage?: LanguageModelUsage,
  ) {
    this.evalPrefix = `${category}/${name}`;
    this.runLogPath = join(outputProjectDir, "run.log");
    appendLog(this.runLogPath, `=== Eval: ${this.evalPrefix} ===`);
  }

  /** Record the result of a step, logging and reporting to Convex. */
  recordStepResult(
    stepName: StepName,
    scoreName: string,
    passed: boolean,
    stepStart: number,
    failureReason?: string,
  ): void {
    this.scores.push({ name: scoreName, score: passed ? 1 : 0 });
    this.stepResults.set(stepName, passed);

    const elapsed = ((Date.now() - stepStart) / 1000).toFixed(1);
    if (passed) {
      appendLog(this.runLogPath, `[ok] ${stepName}`);
      logInfo(`[${this.evalPrefix}] ${stepName}: PASS (${elapsed}s)`);
      if (this.evalId) {
        void recordStep(this.evalId, stepName, {
          kind: "passed",
          durationMs: Date.now() - stepStart,
        });
      }
    } else {
      const reason = failureReason ?? `${stepName} failed`;
      logInfo(`[${this.evalPrefix}] ${stepName}: FAIL`);
      if (this.evalId) {
        void recordStep(this.evalId, stepName, {
          kind: "failed",
          failureReason: reason,
          durationMs: Date.now() - stepStart,
        });
      }
    }
  }

  /** Mark this eval as early-exited due to a blocking step failure. */
  async reportEarlyExit(failureReason: string): Promise<void> {
    if (this.evalId) {
      await completeEval(
        this.evalId,
        {
          kind: "failed",
          failureReason,
          durationMs: Date.now() - this.evalStartTime,
          usage: this.usage,
        },
        this.outputProjectDir,
      );
    }
  }

  /** Report final eval completion (called after all steps). */
  async reportCompletion(testsRatio: number): Promise<void> {
    if (!this.evalId) return;

    const allPassed =
      [...this.stepResults.values()].every(Boolean) && testsRatio === 1;

    const evalDuration = Date.now() - this.evalStartTime;
    if (allPassed) {
      await completeEval(
        this.evalId,
        { 
          kind: "passed", 
          durationMs: evalDuration,
          usage: this.usage,
        },
        this.outputProjectDir,
      );
    } else {
      const failureReasons: string[] = [];
      for (const [step, passed] of this.stepResults) {
        if (!passed) failureReasons.push(`${step} fail`);
      }
      if (testsRatio !== 1) {
        failureReasons.push(
          `tests fail (${(testsRatio * 100).toFixed(0)}%)`,
        );
      }
      await completeEval(
        this.evalId,
        {
          kind: "failed",
          failureReason: failureReasons[0] ?? "unknown fail",
          durationMs: evalDuration,
          usage: this.usage,
        },
        this.outputProjectDir,
      );
    }
  }

  /** Run a command step (install, deploy, tsc, eslint) with logging and reporting. */
  async runStep(
    stepName: StepName,
    scoreName: string,
    handler: () => Promise<Array<{ cmd: string; stdout: string }>>,
    logLabel: string,
    cmdPrefix = "",
  ): Promise<{ passed: boolean; error?: string }> {
    logInfo(`[${this.evalPrefix}] ${logLabel}`);
    const stepStart = Date.now();
    const result = await runCommandStep(
      this.runLogPath,
      handler,
      stepName,
      logLabel,
      cmdPrefix,
    );
    this.recordStepResult(
      stepName,
      scoreName,
      result.passed,
      stepStart,
      result.passed ? undefined : result.error ?? `${stepName} failed`,
    );
    return result;
  }
}

// ── Main scorer ───────────────────────────────────────────────────────

export async function convexScorer(
  tempdir: string,
  _input: string,
  expected: Record<string, string>,
  metadata: Record<string, unknown>,
  output: Record<string, string>,
): Promise<ScoreResult[]> {
  const model = metadata.model as string;
  const category = metadata.category as string;
  const name = metadata.eval_name as string;
  const evalId = metadata.eval_id as string | undefined;
  const usage = metadata.usage as LanguageModelUsage | undefined;

  const outputProjectDir = resolve(
    join(tempdir, "output", model, category, name),
  );
  mkdirSync(outputProjectDir, { recursive: true });

  const ctx = new ScoringContext(category, name, evalId, outputProjectDir, usage);

  // ── Step 1: Write filesystem ──
  const fsStart = Date.now();
  try {
    writeFilesystem(outputProjectDir, output);
    ctx.recordStepResult("filesystem", "Valid filesystem output", true, fsStart);
    if (evalId) {
      void uploadEvalOutput(evalId, outputProjectDir);
    }
  } catch (e) {
    ctx.recordStepResult(
      "filesystem",
      "Valid filesystem output",
      false,
      fsStart,
      String(e),
    );
    await ctx.reportEarlyExit("filesystem fail");
    return ctx.scores;
  }

  // ── Step 2: Install dependencies ──
  const installResult = await ctx.runStep(
    "install",
    "`bun install` succeeds",
    () => installDependencies(outputProjectDir),
    "Installing dependencies (bun install)",
  );
  if (!installResult.passed) {
    await ctx.reportEarlyExit("install fail");
    if (!isInfrastructureStepFailure("install", installResult.error)) {
      return ctx.scores;
    }
    throw new InfrastructureError(
      `[install] ${installResult.error ?? "bun install failed"}`,
    );
  }

  // ── Steps 3-6: Deploy, typecheck, lint, test (inside backend context) ──
  const outputBackendDir = join(
    tempdir,
    "backends",
    "output",
    model,
    category,
    name,
  );
  mkdirSync(outputBackendDir, { recursive: true });

  await withConvexBackend(outputBackendDir, async (outputBackend) => {
    // Deploy
    const deployResult = await ctx.runStep(
      "deploy",
      "`convex dev` succeeds",
      () => deploy(outputBackend, outputProjectDir),
      `Deploying generated backend on port ${outputBackend.port}`,
    );
    if (!deployResult.passed) {
      await ctx.reportEarlyExit("convex dev fail");
      if (!isInfrastructureStepFailure("deploy", deployResult.error)) {
        return;
      }
      throw new InfrastructureError(
        `[deploy] ${deployResult.error ?? "convex dev failed"}`,
      );
    }

    // Typecheck
    ensureConvexTsconfig(outputProjectDir);
    const tscResult = await ctx.runStep(
      "tsc",
      "Passes tsc",
      () => typecheckCode(outputProjectDir),
      "Typechecking (tsc)",
    );
    if (
      !tscResult.passed &&
      isInfrastructureStepFailure("tsc", tscResult.error)
    ) {
      await ctx.reportEarlyExit("tsc fail");
      throw new InfrastructureError(
        `[tsc] ${tscResult.error ?? "tsc failed"}`,
      );
    }

    // Lint
    await ctx.runStep(
      "eslint",
      "Passes eslint",
      () => lintCode(outputProjectDir),
      "Linting (eslint)",
    );

    // Run tests
    await runTestsStep(ctx, tempdir, outputBackend, model, category, name);
  });

  return ctx.scores;
}

// ── Test step (more complex than the others) ──────────────────────────

async function runTestsStep(
  ctx: ScoringContext,
  tempdir: string,
  outputBackend: ConvexBackend,
  model: string,
  category: string,
  name: string,
): Promise<void> {
  const evalPath = `evals/${category}/${name}`;
  const { answerProjectDir, answerBackendDir } = setupAnswerBackend(
    tempdir,
    evalPath,
    model,
    category,
    name,
  );

  logInfo(`[${ctx.evalPrefix}] Setting up answer backend`);

  await runCommandStep(
    ctx.runLogPath,
    () => installDependencies(answerProjectDir),
    "answer-bun",
    "(answer) bun install",
    "(answer) ",
  );

  await withConvexBackend(answerBackendDir, async (answerBackend) => {
    logInfo(
      `[${ctx.evalPrefix}] Deploying answer backend on port ${answerBackend.port}`,
    );
    await runCommandStep(
      ctx.runLogPath,
      () => deploy(answerBackend, answerProjectDir),
      "answer-convex-dev",
      "(answer) convex dev",
      "(answer) ",
    );

    const testFile = resolve(join(evalPath, "grader.test.ts"));
    const stepStart = Date.now();
    let testsRatio = 0;
    let vitestStdout: string | null = null;
    let testCmd: string | null = null;

    try {
      logInfo(`[${ctx.evalPrefix}] Running tests`);
      const testResult = await runTests(
        outputBackend,
        answerBackend,
        testFile,
        ctx.outputProjectDir,
      );
      testsRatio = testResult.ratio;
      vitestStdout = testResult.stdout;
      testCmd = testResult.cmd;

      ctx.scores.push({ name: "Tests pass", score: testsRatio });
      const elapsed = ((Date.now() - stepStart) / 1000).toFixed(1);

      if (testsRatio === 1) {
        logInfo(`[${ctx.evalPrefix}] tests: PASS (${elapsed}s)`);
        if (ctx.evalId) {
          void recordStep(ctx.evalId, "tests", {
            kind: "passed",
            durationMs: Date.now() - stepStart,
          });
        }
      } else {
        const pct = (testsRatio * 100).toFixed(0);
        logInfo(`[${ctx.evalPrefix}] tests: FAIL (${pct}% passed, ${elapsed}s)`);
        if (ctx.evalId) {
          void recordStep(ctx.evalId, "tests", {
            kind: "failed",
            failureReason: `tests failed (${pct}%)`,
            durationMs: Date.now() - stepStart,
          });
        }
      }
    } catch (e) {
      if (e instanceof TestsFailedError) {
        testsRatio = e.ratio;
        vitestStdout = e.vitestStdout;
        testCmd = e.testCmd;
        ctx.scores.push({ name: "Tests pass", score: e.ratio });
        const pct = (e.ratio * 100).toFixed(0);
        const elapsed = ((Date.now() - stepStart) / 1000).toFixed(1);
        logInfo(
          `[${ctx.evalPrefix}] tests: FAIL (${pct}% passed, ${elapsed}s)`,
        );
        if (ctx.evalId) {
          void recordStep(ctx.evalId, "tests", {
            kind: "failed",
            failureReason: `tests failed (${pct}%)`,
            durationMs: Date.now() - stepStart,
          });
        }
      } else {
        ctx.scores.push({ name: "Tests pass", score: 0 });
        logInfo(
          `[${ctx.evalPrefix}] tests: FAIL (error: ${String(e).slice(0, 100)})`,
        );
        if (ctx.evalId) {
          void recordStep(ctx.evalId, "tests", {
            kind: "failed",
            failureReason: String(e),
            durationMs: Date.now() - stepStart,
          });
        }
      }
      appendLog(ctx.runLogPath, `[error] vitest: ${String(e)}`);
    }

    if (testCmd && vitestStdout) {
      logVitestResults(ctx.runLogPath, testCmd, vitestStdout);
    }

    await ctx.reportCompletion(testsRatio);
  });
}

// ── Error types ───────────────────────────────────────────────────────

class TestsFailedError extends Error {
  constructor(
    message: string,
    public ratio: number,
    public vitestStdout: string,
    public testCmd: string,
  ) {
    super(message);
  }
}

// ── Step implementations ──────────────────────────────────────────────

function writeFilesystem(
  projectDir: string,
  output: Record<string, string>,
): void {
  const absDir = resolve(projectDir);
  for (const [relativePath, content] of Object.entries(output)) {
    const filePath = resolve(join(absDir, relativePath));
    if (!filePath.startsWith(absDir)) {
      throw new Error(
        `Invalid filesystem output: ${filePath} is not in ${absDir}`,
      );
    }
    mkdirSync(join(filePath, ".."), { recursive: true });
    writeFileSync(filePath, content, "utf-8");
  }
}

/** Combine stdout and stderr from a shell result into a single string. */
function combinedOutput(result: { stdout: Buffer; stderr: Buffer }): string {
  const stdout = result.stdout.toString();
  const stderr = result.stderr.toString();
  return [stdout, stderr].filter(Boolean).join("\n");
}

async function installDependencies(
  projectDir: string,
): Promise<Array<{ cmd: string; stdout: string }>> {
  const result = await withTimeout(
    $`bun install`.cwd(projectDir).nothrow().quiet(),
    TIMEOUTS.bunInstall,
    "bun install",
  );
  if (result.exitCode !== 0) {
    throw new Error(`Failed to install dependencies:\n${combinedOutput(result)}`);
  }
  return [{ cmd: "bun install", stdout: combinedOutput(result) }];
}

async function deploy(
  backend: ConvexBackend,
  projectDir: string,
): Promise<Array<{ cmd: string; stdout: string }>> {
  const convexUrl = `http://localhost:${backend.port}`;

  // Run codegen --init first
  const initResult = await withTimeout(
    $`bunx convex codegen --typecheck disable --init`
      .cwd(projectDir)
      .nothrow()
      .quiet(),
    TIMEOUTS.codegen,
    "convex codegen",
  );

  // Deploy
  const deployResult = await withTimeout(
    $`bunx convex dev --once --admin-key ${ADMIN_KEY} --url ${convexUrl}`
      .cwd(projectDir)
      .nothrow()
      .quiet(),
    TIMEOUTS.deploy,
    "convex dev",
  );

  const stdout = deployResult.stdout.toString();
  const deployOutput = combinedOutput(deployResult);
  if (deployResult.exitCode !== 0 && !stdout.includes("Convex functions ready!")) {
    throw new Error(`Failed to deploy:\n${deployOutput}`);
  }

  return [
    {
      cmd: "bunx convex codegen --typecheck disable --init",
      stdout: combinedOutput(initResult),
    },
    { cmd: `bunx convex dev --once --url ${convexUrl}`, stdout: deployOutput },
  ];
}

async function typecheckCode(
  projectDir: string,
): Promise<Array<{ cmd: string; stdout: string }>> {
  const results: Array<{ cmd: string; stdout: string }> = [];
  const typecheckTargets = getTypecheckTargets(projectDir);

  for (const typecheckTarget of typecheckTargets) {
    const result = await withTimeout(
      $`bunx tsc -noEmit -p ${typecheckTarget}`.cwd(projectDir).nothrow().quiet(),
      TIMEOUTS.tsc,
      `tsc (${typecheckTarget})`,
    );
    if (result.exitCode !== 0) {
      throw new Error(`Failed to typecheck code:\n${combinedOutput(result)}`);
    }
    results.push({
      cmd: `bunx tsc -noEmit -p ${typecheckTarget}`,
      stdout: combinedOutput(result),
    });
  }

  return results;
}

async function lintCode(
  projectDir: string,
): Promise<Array<{ cmd: string; stdout: string }>> {
  const results: Array<{ cmd: string; stdout: string }> = [];
  const eslintConfig = resolve("eslint.config.mjs");

  const eslintBin = resolve("node_modules/.bin/eslint");

  const eslintConvex = await withTimeout(
    $`${eslintBin} -c ${eslintConfig} convex`
      .cwd(projectDir)
      .nothrow()
      .quiet(),
    TIMEOUTS.eslint,
    "eslint (convex)",
  );
  if (eslintConvex.exitCode !== 0) {
    throw new Error(`Failed to lint code:\n${combinedOutput(eslintConvex)}`);
  }
  results.push({
    cmd: `${eslintBin} -c ${eslintConfig} convex`,
    stdout: combinedOutput(eslintConvex),
  });

  const srcDir = join(projectDir, "src");
  if (existsSync(srcDir)) {
    const srcEslintConfig = resolve("src.eslint.config.mjs");
    const eslintSrc = await withTimeout(
      $`${eslintBin} -c ${srcEslintConfig} src`
        .cwd(projectDir)
        .nothrow()
        .quiet(),
      TIMEOUTS.eslint,
      "eslint (src)",
    );
    if (eslintSrc.exitCode !== 0) {
      throw new Error(`Failed to lint code:\n${combinedOutput(eslintSrc)}`);
    }
    results.push({
      cmd: `${eslintBin} -c ${srcEslintConfig} src`,
      stdout: combinedOutput(eslintSrc),
    });
  }
  return results;
}

function setupAnswerBackend(
  tempdir: string,
  evalPath: string,
  model: string,
  category: string,
  name: string,
): { answerProjectDir: string; answerBackendDir: string } {
  const answerProjectDir = join(tempdir, "answer", model, category, name);
  mkdirSync(answerProjectDir, { recursive: true });

  const answerDir = join(evalPath, "answer");
  for (const filePath of walkAnswer(answerDir)) {
    const relPath = relative(answerDir, filePath).replace(/\\/g, "/");
    const destPath = join(answerProjectDir, relPath);
    mkdirSync(join(destPath, ".."), { recursive: true });
    writeFileSync(destPath, readFileSync(filePath));
  }

  const answerBackendDir = join(
    tempdir,
    "backends",
    "answer",
    model,
    category,
    name,
  );
  mkdirSync(answerBackendDir, { recursive: true });

  return { answerProjectDir, answerBackendDir };
}

async function runTests(
  backend: ConvexBackend,
  answerBackend: ConvexBackend,
  testFile: string,
  outputProjectDir: string,
): Promise<{ ratio: number; stdout: string; cmd: string }> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    CONVEX_PORT: String(backend.port),
    CONVEX_SITE_PORT: String(backend.siteProxyPort),
    CONVEX_ANSWER_PORT: String(answerBackend.port),
    MODEL_OUTPUT_DIR: outputProjectDir,
  };

  const tmpJsonPath = join(
    tmpdir(),
    `vitest-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );

  const cmd = `bunx vitest run ${testFile} --reporter=json --outputFile ${tmpJsonPath} --reporter=default --no-color`;
  const result = await withTimeout(
    $`bunx vitest run ${testFile} --reporter=json --outputFile ${tmpJsonPath} --reporter=default --no-color`
      .env(env)
      .nothrow()
      .quiet(),
    TIMEOUTS.vitest,
    "vitest",
  );

  const stdout = result.text();

  let ratio = 0;
  try {
    const jsonContent = readFileSync(tmpJsonPath, "utf-8");
    const parsed = JSON.parse(jsonContent) as {
      numTotalTests?: number;
      numPassedTests?: number;
    };
    const total = parsed.numTotalTests ?? 0;
    const passed = parsed.numPassedTests ?? 0;
    ratio = total > 0 ? passed / total : 0;
  } catch (e) {
    if (result.exitCode !== 0) {
      throw new Error(`Tests failed:\n${stdout}`);
    }
    throw new Error(
      `Failed to parse test results from ${tmpJsonPath}: ${String(e)}`,
    );
  } finally {
    try {
      const { unlinkSync } = await import("fs");
      unlinkSync(tmpJsonPath);
    } catch {
      /* ignore */
    }
  }

  if (ratio !== 1) {
    throw new TestsFailedError(
      `Tests failed (ratio: ${ratio})`,
      ratio,
      stdout,
      cmd,
    );
  }

  return { ratio, stdout, cmd };
}

/** Walk answer directory, yielding paths to .ts and package.json files. */
export function* walkAnswer(answerDir: string): Generator<string> {
  if (!existsSync(answerDir)) return;
  for (const entry of readdirSync(answerDir, { withFileTypes: true })) {
    const fullPath = join(answerDir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "_generated")
        continue;
      yield* walkAnswer(fullPath);
    } else {
      if (entry.name === "package.json" || entry.name.endsWith(".ts")) {
        yield fullPath;
      }
    }
  }
}
