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
  mkdtempSync,
  rmSync,
} from "fs";
import { join, resolve, relative } from "path";
import { platform, tmpdir } from "os";
import { fileURLToPath } from "node:url";
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
import {
  GRADER_EVENTS_PATH_ENV,
  type GraderEvent,
} from "../grader/infrastructure.js";

// ── Timeout constants (ms) ───────────────────────────────────────────

const RAW_MODEL_RESPONSE_DEBUG_FILE = "raw_model_response.md";
const EMPTY_PARSED_OUTPUT_ERROR = "Empty parsed model output";

const TIMEOUTS = {
  bunInstall: 120_000,
  codegen: 60_000,
  tsc: 120_000,
  eslint: 120_000,
  deploy: 90_000,
  // Must exceed the summed per-test timeouts of the slowest grader, so a
  // failing candidate exhausts individual test timeouts (reported as test
  // failures) instead of the whole vitest run being killed. Current worst
  // case is 004-actions/003 with two 90s poll-based tests.
  vitest: 300_000,
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

export async function retryInfrastructureOperation<T>(
  operation: () => Promise<T>,
  sleep: (ms: number) => Promise<unknown> = Bun.sleep,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!isEnvironmentFailure(String(error).toLowerCase())) throw error;
    logInfo(`[infrastructure] ${String(error)}; retrying once in 1s`);
    await sleep(1_000);
    return await operation();
  }
}

export async function runCommandWithTimeout(
  command: string[],
  cwd: string,
  timeoutMs: number,
  label: string,
  env?: Record<string, string>,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(command, {
    cwd,
    env,
    detached: true,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdoutPromise = new Response(proc.stdout).text();
  const stderrPromise = new Response(proc.stderr).text();
  const completed = Promise.all([proc.exited, stdoutPromise, stderrPromise]);

  let timer: ReturnType<typeof setTimeout>;
  try {
    const [exitCode, stdout, stderr] = await Promise.race([
      completed,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs / 1000}s`));
        }, timeoutMs);
      }),
    ]);
    return { exitCode, stdout, stderr };
  } catch (error) {
    try {
      if (platform() === "win32") {
        if (proc.exitCode === null) proc.kill("SIGKILL");
      } else {
        // The leader may have exited while a descendant still holds its pipes.
        // Kill the owned process group even after the leader has exited.
        process.kill(-proc.pid, "SIGKILL");
      }
    } catch {
      if (proc.exitCode === null) {
        try {
          proc.kill("SIGKILL");
        } catch {
          // The process exited between the status check and the signal.
        }
      }
    }
    if (proc.exitCode === null) await proc.exited;
    // A lifecycle descendant may still hold an inherited pipe on platforms
    // without process-group signals. Never let stream draining mask the timeout.
    void completed.catch(() => {});
    throw error;
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
    return (
      isEnvironmentFailure(lower) || lower.includes("convex dev timed out")
    );
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
    // NOTE: do not match bare "rate limit"/"rate_limit" here - step errors
    // embed project paths, and an eval named *rate_limit* would classify
    // every model failure as infrastructure and abort the whole run.
    // Provider throttling always surfaces as 429/too-many-requests.
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

interface Tsconfig {
  compilerOptions?: { types?: unknown } & Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Models sometimes author a `tsconfig.json` whose `compilerOptions.types` lists type
 * packages that the project never installs — e.g. `["node"]` without `@types/node`, or
 * `["vite/client"]` without vite. Any such entry makes tsc fail hard with TS2688
 * ("Cannot find type definition file for 'X' ... specified in compilerOptions") before
 * the actual Convex code is ever checked, which unfairly tanks the score on otherwise
 * correct output.
 *
 * A `types` allowlist is essentially never what these evals need (the reference answers
 * ship no such field). Drop any listed type package that doesn't resolve in the
 * project's `node_modules`, so the typecheck reflects Convex correctness rather than
 * tsconfig hygiene. Legitimately-needed types (a model that installs `@types/node` and
 * lists `node`, or installs vitest — which brings vite — and lists `vite/client`) still
 * resolve and are kept. Runs after install, before tsc. Returns the removed entries.
 */
/**
 * Normalize module resolution in model-authored tsconfigs. Convex projects
 * require Bundler-style resolution to see package `exports` (the deploy
 * path always resolves them via esbuild); models often emit legacy
 * `moduleResolution: "node"` boilerplate, which fails tsc for reasons
 * orthogonal to every eval's concept. Returns a description of each change.
 */
export function normalizeModelTsconfigResolution(projectDir: string): string[] {
  const adjusted: string[] = [];
  const tsconfigPaths = [
    resolve(join(projectDir, "tsconfig.json")),
    resolve(join(projectDir, "convex", "tsconfig.json")),
  ];

  for (const tsconfigPath of tsconfigPaths) {
    if (!existsSync(tsconfigPath)) continue;

    let parsed: Tsconfig;
    try {
      parsed = JSON.parse(readFileSync(tsconfigPath, "utf-8")) as Tsconfig;
    } catch {
      continue; // Non-strict JSON - leave untouched.
    }
    if (parsed.compilerOptions === undefined) {
      (parsed as Record<string, unknown>).compilerOptions = {};
    }
    const compilerOptions = parsed.compilerOptions as Record<string, unknown>;

    let changed = false;
    const moduleResolution = compilerOptions.moduleResolution;
    const resolutionIsModern =
      typeof moduleResolution === "string" &&
      ["bundler", "node16", "nodenext"].includes(
        moduleResolution.toLowerCase(),
      );
    if (!resolutionIsModern) {
      // Absent counts too: tsc then defaults to legacy node resolution.
      adjusted.push(
        `${tsconfigPath}: moduleResolution ${typeof moduleResolution === "string" ? moduleResolution : "(absent)"} -> Bundler`,
      );
      compilerOptions.moduleResolution = "Bundler";
      changed = true;
    }
    const moduleKind = compilerOptions.module;
    const moduleSupportsBundler =
      typeof moduleKind === "string" &&
      (moduleKind.toLowerCase() === "preserve" ||
        moduleKind.toLowerCase().startsWith("es"));
    if (
      compilerOptions.moduleResolution === "Bundler" &&
      !moduleSupportsBundler
    ) {
      adjusted.push(
        `${tsconfigPath}: module ${typeof moduleKind === "string" ? moduleKind : "(absent)"} -> ESNext`,
      );
      compilerOptions.module = "ESNext";
      changed = true;
    }
    // An explicit lib without web-standard globals (Response, Request, fetch)
    // breaks Convex HTTP actions; tsc's default lib (lib absent) includes DOM,
    // and WebWorker declares the same globals, so only an explicit list with
    // neither needs fixing - appending dom alongside WebWorker would create
    // duplicate global declarations instead.
    const lib = compilerOptions.lib;
    if (
      Array.isArray(lib) &&
      !lib.some(
        (l) =>
          typeof l === "string" &&
          ["dom", "webworker"].includes(l.toLowerCase()),
      )
    ) {
      adjusted.push(`${tsconfigPath}: lib ${JSON.stringify(lib)} -> +dom`);
      lib.push("dom");
      changed = true;
    }
    if (changed) {
      writeFileSync(
        tsconfigPath,
        `${JSON.stringify(parsed, null, 2)}
`,
        "utf-8",
      );
    }
  }

  return adjusted;
}

export function sanitizeModelTsconfigTypes(projectDir: string): string[] {
  const nodeModules = resolve(join(projectDir, "node_modules"));
  const removed: string[] = [];

  const tsconfigPaths = [
    resolve(join(projectDir, "tsconfig.json")),
    resolve(join(projectDir, "convex", "tsconfig.json")),
  ];

  for (const tsconfigPath of tsconfigPaths) {
    if (!existsSync(tsconfigPath)) continue;

    let parsed: Tsconfig;
    try {
      parsed = JSON.parse(readFileSync(tsconfigPath, "utf-8")) as Tsconfig;
    } catch {
      continue; // Non-strict JSON (comments/trailing commas) — leave untouched.
    }

    const types = parsed.compilerOptions?.types;
    if (!Array.isArray(types)) continue;

    const kept = types.filter((entry) => {
      if (typeof entry !== "string") return true;
      if (typeReferenceResolvable(nodeModules, entry)) return true;
      removed.push(entry);
      return false;
    });
    if (kept.length === types.length) continue;

    const compilerOptions = parsed.compilerOptions as Record<string, unknown>;
    if (kept.length === 0) {
      delete compilerOptions.types;
    } else {
      compilerOptions.types = kept;
    }
    writeFileSync(
      tsconfigPath,
      `${JSON.stringify(parsed, null, 2)}\n`,
      "utf-8",
    );
  }

  return removed;
}

/** Whether a `compilerOptions.types` entry resolves to an installed package. */
function typeReferenceResolvable(nodeModules: string, entry: string): boolean {
  const pkg = entry.startsWith("@")
    ? entry.split("/").slice(0, 2).join("/")
    : entry.split("/")[0];
  const atTypes = pkg.startsWith("@")
    ? `@types/${pkg.slice(1).replace("/", "__")}`
    : `@types/${pkg}`;
  return (
    existsSync(join(nodeModules, pkg)) || existsSync(join(nodeModules, atTypes))
  );
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
    readonly generationDurationMs?: number,
    readonly metadata: Record<string, unknown> = {},
  ) {
    this.evalPrefix = `${category}/${name}`;
    this.runLogPath = join(outputProjectDir, "run.log");
    appendLog(this.runLogPath, `=== Eval: ${this.evalPrefix} ===`);

    const rawResponseDebug = metadataRawResponseDebug(this.metadata);
    if (rawResponseDebug !== undefined) {
      writeFileSync(
        join(outputProjectDir, RAW_MODEL_RESPONSE_DEBUG_FILE),
        rawResponseDebug,
        "utf-8",
      );
      appendLog(
        this.runLogPath,
        `[debug] saved truncated raw model response to ${RAW_MODEL_RESPONSE_DEBUG_FILE}`,
      );
    }
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
      appendLog(this.runLogPath, `[error] ${stepName}: ${reason}`);
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
          generationDurationMs: this.generationDurationMs,
          usage: this.usage,
        },
        this.outputProjectDir,
      );
    }
  }

  /** Preserve an unscored attempt without completing it as a model failure. */
  async reportInfrastructureFailure(error: InfrastructureError): Promise<void> {
    appendLog(
      this.runLogPath,
      `[infrastructure] ${error.name}: ${error.message}`,
    );
    try {
      writeFileSync(
        join(this.outputProjectDir, "grader-error.json"),
        JSON.stringify(
          {
            kind: "infrastructure_error",
            score: null,
            eval: this.evalPrefix,
            message: error.message,
            usage: this.usage,
          },
          null,
          2,
        ) + "\n",
      );
    } catch (artifactError) {
      // A disk failure must not replace the InfrastructureError that invalidates
      // the run, even when it also prevents us from preserving local evidence.
      appendLog(
        this.runLogPath,
        `[infrastructure] Could not save grader error: ${String(artifactError)}`,
      );
    }
    if (this.evalId) {
      await uploadEvalOutput(this.evalId, this.outputProjectDir);
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
          generationDurationMs: this.generationDurationMs,
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
        failureReasons.push(`tests fail (${(testsRatio * 100).toFixed(0)}%)`);
      }
      await completeEval(
        this.evalId,
        {
          kind: "failed",
          failureReason: failureReasons[0] ?? "unknown fail",
          durationMs: evalDuration,
          generationDurationMs: this.generationDurationMs,
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
      result.passed ? undefined : (result.error ?? `${stepName} failed`),
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
  const generationDurationMs = metadata.generationDurationMs as
    | number
    | undefined;

  const outputProjectDir = resolve(
    join(tempdir, "output", model, category, name),
  );
  mkdirSync(outputProjectDir, { recursive: true });

  const ctx = new ScoringContext(
    category,
    name,
    evalId,
    outputProjectDir,
    usage,
    generationDurationMs,
    metadata,
  );

  // ── Step 1: Write filesystem ──
  const fsStart = Date.now();
  try {
    writeFilesystem(outputProjectDir, output);
    ctx.recordStepResult(
      "filesystem",
      "Valid filesystem output",
      true,
      fsStart,
    );
    if (evalId) {
      void uploadEvalOutput(evalId, outputProjectDir);
    }
  } catch (e) {
    const failureReason = filesystemFailureReason(String(e), metadata);
    ctx.recordStepResult(
      "filesystem",
      "Valid filesystem output",
      false,
      fsStart,
      failureReason,
    );
    await ctx.reportEarlyExit(failureReason);
    return ctx.scores;
  }

  // ── Static-pipeline evals: grade the raw files and stop ──
  const pipeline = getEvalPipeline(category, name);
  if (pipeline === "static") {
    await runFileTestsStep(ctx, category, name, pipeline);
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

  // Module graders check TypeScript and execute exports against installed
  // dependencies themselves. They need no generated server or deployment.
  if (pipeline === "module") {
    await runFileTestsStep(ctx, category, name, pipeline);
    return ctx.scores;
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
    const removedTypes = sanitizeModelTsconfigTypes(outputProjectDir);
    if (removedTypes.length > 0) {
      appendLog(
        ctx.runLogPath,
        `[setup] dropped unresolvable tsconfig types: ${removedTypes.join(", ")}`,
      );
    }
    const resolutionChanges =
      normalizeModelTsconfigResolution(outputProjectDir);
    if (resolutionChanges.length > 0) {
      appendLog(
        ctx.runLogPath,
        `[setup] normalized tsconfig resolution: ${resolutionChanges.join(", ")}`,
      );
    }
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
      throw new InfrastructureError(`[tsc] ${tscResult.error ?? "tsc failed"}`);
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

/**
 * Static graders only inspect raw output (selection). Module graders run
 * after dependency installation and own their type/runtime checks (usage).
 * Existing evals default to the full backend pipeline.
 */
export function getEvalPipeline(
  category: string,
  name: string,
): "backend" | "static" | "module" {
  const configPath = resolve(join("evals", category, name, "eval.json"));
  if (!existsSync(configPath)) return "backend";
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf-8")) as {
      pipeline?: string;
    };
    return parsed.pipeline === "static" || parsed.pipeline === "module"
      ? parsed.pipeline
      : "backend";
  } catch {
    return "backend";
  }
}

async function runFileTestsStep(
  ctx: ScoringContext,
  category: string,
  name: string,
  pipeline: "static" | "module",
): Promise<void> {
  const testFile = resolve(join("evals", category, name, "grader.test.ts"));
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    MODEL_OUTPUT_DIR: ctx.outputProjectDir,
  };
  const stepStart = Date.now();
  let testsRatio = 0;
  let vitestStdout: string | null = null;
  let testCmd: string | null = null;

  try {
    logInfo(`[${ctx.evalPrefix}] Running ${pipeline} grader`);
    const testResult = await executeVitest(env, testFile);
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
    if (e instanceof InfrastructureError) {
      await ctx.reportInfrastructureFailure(e);
      throw e;
    }
    if (e instanceof TestsFailedError) {
      testsRatio = e.ratio;
      vitestStdout = e.vitestStdout;
      testCmd = e.testCmd;
      ctx.scores.push({ name: "Tests pass", score: e.ratio });
      const pct = (e.ratio * 100).toFixed(0);
      const elapsed = ((Date.now() - stepStart) / 1000).toFixed(1);
      logInfo(`[${ctx.evalPrefix}] tests: FAIL (${pct}% passed, ${elapsed}s)`);
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
}

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

  const answerInstall = await runCommandStep(
    ctx.runLogPath,
    () => installDependencies(answerProjectDir),
    "answer-bun",
    "(answer) bun install",
    "(answer) ",
  );
  if (!answerInstall.passed) {
    const error = new InfrastructureError(
      `[grader setup] Reference answer install failed: ${answerInstall.error}`,
    );
    await ctx.reportInfrastructureFailure(error);
    throw error;
  }

  await withConvexBackend(answerBackendDir, async (answerBackend) => {
    logInfo(
      `[${ctx.evalPrefix}] Deploying answer backend on port ${answerBackend.port}`,
    );
    const answerDeploy = await runCommandStep(
      ctx.runLogPath,
      () => deploy(answerBackend, answerProjectDir),
      "answer-convex-dev",
      "(answer) convex dev",
      "(answer) ",
    );
    if (!answerDeploy.passed) {
      const error = new InfrastructureError(
        `[grader setup] Reference answer deploy failed: ${answerDeploy.error}`,
      );
      await ctx.reportInfrastructureFailure(error);
      throw error;
    }

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
      }
    } catch (e) {
      if (e instanceof InfrastructureError) {
        await ctx.reportInfrastructureFailure(e);
        throw e;
      }
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

export function writeFilesystem(
  projectDir: string,
  output: Record<string, string>,
): void {
  if (Object.keys(output).length === 0) {
    throw new Error(EMPTY_PARSED_OUTPUT_ERROR);
  }

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

function metadataRawResponseDebug(
  metadata: Record<string, unknown>,
): string | undefined {
  const value = metadata.raw_model_response_debug;
  return typeof value === "string" ? value : undefined;
}

function metadataRawResponseLength(
  metadata: Record<string, unknown>,
): number | undefined {
  const value = metadata.raw_model_response_length;
  return typeof value === "number" ? value : undefined;
}

function filesystemFailureReason(
  error: string,
  metadata: Record<string, unknown>,
): string {
  if (!error.includes(EMPTY_PARSED_OUTPUT_ERROR)) return error;

  const rawLength = metadataRawResponseLength(metadata);
  if (rawLength === 0) {
    return "[infrastructure] empty provider response";
  }
  if (rawLength !== undefined) {
    return `empty parsed model output: non-empty raw response (${rawLength} chars) did not contain parseable files`;
  }
  return "empty parsed model output";
}

/** Combine stdout and stderr from a shell result into a single string. */
function combinedOutput(result: { stdout: Buffer; stderr: Buffer }): string {
  const stdout = result.stdout.toString();
  const stderr = result.stderr.toString();
  return [stdout, stderr].filter(Boolean).join("\n");
}

export function formatDeployFailure(
  initialCodegen: { exitCode: number; output: string },
  deployOutput: string,
): string {
  return [
    "Failed to deploy:",
    `Initial codegen (exit ${initialCodegen.exitCode}):`,
    initialCodegen.output || "(no output)",
    "convex dev:",
    deployOutput || "(no output)",
  ].join("\n");
}

async function installDependencies(
  projectDir: string,
): Promise<Array<{ cmd: string; stdout: string }>> {
  return retryInfrastructureOperation(async () => {
    const result = await runCommandWithTimeout(
      ["bun", "install"],
      projectDir,
      TIMEOUTS.bunInstall,
      "bun install",
    );
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
    if (result.exitCode !== 0) {
      throw new Error(`Failed to install dependencies:\n${output}`);
    }
    return [{ cmd: "bun install", stdout: output }];
  });
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
  if (
    deployResult.exitCode !== 0 &&
    !stdout.includes("Convex functions ready!")
  ) {
    throw new Error(
      formatDeployFailure(
        {
          exitCode: initResult.exitCode,
          output: combinedOutput(initResult),
        },
        deployOutput,
      ),
    );
  }

  return [
    {
      // Initial codegen fails when no deployment is configured yet (dev
      // --once regenerates below), but surface the exit code so real
      // failures - e.g. a broken component config - are visible in run.log.
      cmd: `bunx convex codegen --typecheck disable --init (exit ${initResult.exitCode})`,
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
      $`bunx tsc -noEmit -p ${typecheckTarget}`
        .cwd(projectDir)
        .nothrow()
        .quiet(),
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
    $`${eslintBin} -c ${eslintConfig} convex`.cwd(projectDir).nothrow().quiet(),
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
  return executeVitest(env, testFile);
}

function objectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A completed assertion report is necessary, but not sufficient, for a score. */
export function evaluateVitestReport(
  report: unknown,
  events: unknown[],
  exitCode: number,
): number {
  const completions: Extract<GraderEvent, { kind: "vitest-end" }>[] = [];
  for (const event of events) {
    if (!objectRecord(event)) {
      throw new InfrastructureError("Malformed grader event");
    }
    if (
      event.kind === "infrastructure" &&
      typeof event.code === "string" &&
      typeof event.message === "string"
    ) {
      throw new InfrastructureError(`[grader:${event.code}] ${event.message}`);
    }
    if (
      event.kind !== "vitest-end" ||
      !["passed", "failed", "interrupted"].includes(String(event.reason)) ||
      !Array.isArray(event.unhandledErrors) ||
      !event.unhandledErrors.every((error) => typeof error === "string")
    ) {
      throw new InfrastructureError("Malformed grader event");
    }
    completions.push(event as (typeof completions)[number]);
  }
  if (completions.length !== 1) {
    throw new InfrastructureError(
      "Vitest did not report one completed grader run",
    );
  }
  const completion = completions[0];
  if (
    completion.reason === "interrupted" ||
    completion.unhandledErrors.length
  ) {
    throw new InfrastructureError(
      `Vitest ${completion.reason}; unhandled errors: ${completion.unhandledErrors.join("\n")}`,
    );
  }

  if (!objectRecord(report)) {
    throw new InfrastructureError(
      "Missing or malformed Vitest assertion report",
    );
  }
  const total = report.numTotalTests;
  const passed = report.numPassedTests;
  const failed = report.numFailedTests;
  if (
    typeof total !== "number" ||
    !Number.isInteger(total) ||
    total <= 0 ||
    typeof passed !== "number" ||
    !Number.isInteger(passed) ||
    passed < 0 ||
    passed > total ||
    typeof failed !== "number" ||
    !Number.isInteger(failed) ||
    failed < 0 ||
    passed + failed > total ||
    typeof report.success !== "boolean" ||
    !Array.isArray(report.testResults)
  ) {
    throw new InfrastructureError("Incomplete Vitest assertion report");
  }
  const assertions: Record<string, unknown>[] = [];
  for (const suite of report.testResults) {
    if (!objectRecord(suite) || !Array.isArray(suite.assertionResults)) {
      throw new InfrastructureError("Malformed Vitest test suite report");
    }
    for (const assertion of suite.assertionResults) {
      if (!objectRecord(assertion) || typeof assertion.status !== "string") {
        throw new InfrastructureError("Malformed Vitest assertion result");
      }
      assertions.push(assertion);
    }
  }
  if (
    assertions.length !== total ||
    assertions.filter((assertion) => assertion.status === "passed").length !==
      passed ||
    assertions.filter((assertion) => assertion.status === "failed").length !==
      failed
  ) {
    throw new InfrastructureError(
      "Vitest assertion counts disagree with its report",
    );
  }
  // Exit 1 is normal for failed assertions. Any other nonzero exit, or exit 1
  // without a failed assertion, means the test process did not produce a score.
  if (
    (exitCode !== 0 && (exitCode !== 1 || failed === 0)) ||
    (exitCode === 0 && failed > 0) ||
    (passed === total && (!report.success || completion.reason !== "passed"))
  ) {
    throw new InfrastructureError(
      `Vitest exited ${exitCode} without a consistent assertion result`,
    );
  }
  return passed / total;
}

async function executeVitest(
  env: Record<string, string>,
  testFile: string,
): Promise<{ ratio: number; stdout: string; cmd: string }> {
  // The runner creates this outside candidate output. A trusted inspector and
  // reporter share it; model strings, thrown messages, and stdout cannot mark a
  // result as infrastructure. Each invocation has a fresh completion handshake.
  let resultDir: string;
  try {
    resultDir = mkdtempSync(join(tmpdir(), "convex-eval-grader-"));
  } catch (error) {
    throw new InfrastructureError(
      `[grader] Could not create result directory: ${String(error)}`,
    );
  }
  const tmpJsonPath = join(resultDir, "assertions.json");
  const eventsPath = join(resultDir, "events.jsonl");
  const reporterPath = fileURLToPath(
    new URL("./graderReporter.ts", import.meta.url),
  );

  // Vitest treats the file argument as a name filter. Exclude local agent
  // worktrees so duplicate graders cannot corrupt each other's backend data.
  const command = [
    "bunx",
    "vitest",
    "run",
    testFile,
    "--exclude",
    "**/.claude/worktrees/**",
    "--reporter=json",
    "--outputFile",
    tmpJsonPath,
    "--reporter=default",
    "--reporter",
    reporterPath,
    "--no-color",
  ];
  const cmd = command.map((arg) => JSON.stringify(arg)).join(" ");
  let stdout = "";
  let ratio: number;
  try {
    writeFileSync(eventsPath, "");
    const result = await runCommandWithTimeout(
      command,
      process.cwd(),
      TIMEOUTS.vitest,
      "vitest",
      { ...env, [GRADER_EVENTS_PATH_ENV]: eventsPath },
    );
    stdout = [result.stdout, result.stderr].filter(Boolean).join("\n");
    const events = readFileSync(eventsPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as unknown);
    const report: unknown = JSON.parse(readFileSync(tmpJsonPath, "utf8"));
    ratio = evaluateVitestReport(report, events, result.exitCode);
  } catch (error) {
    // Do not convert machinery errors into TestsFailedError or a zero score.
    // Preserve both command streams for local evidence and the failed run.
    throw new InfrastructureError(
      `[grader] ${String(error)}\n[cmd] ${cmd}${stdout ? `\n${stdout}` : ""}`,
    );
  } finally {
    try {
      rmSync(resultDir, { recursive: true, force: true });
    } catch {
      // Temporary evidence cleanup must not turn an unscored grader error
      // into a generic exception that the caller would score as a test failure.
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
