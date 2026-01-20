import { spawn } from 'child_process';
import { join } from 'path';
import { mkdirSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import type { EvalRunResult, EvalResult, RunOptions } from './types.js';
import { getRunDir } from './guidelineStore.js';

// Timeout for eval runs (30 minutes) - evals can take a while with many tests
const EVAL_TIMEOUT_MS = 30 * 60 * 1000;

export async function runEvals(options: RunOptions): Promise<EvalRunResult> {
  const runDir = getRunDir(options.provider, options.model, options.runId);
  const outputDir = join(runDir, 'eval_output');
  const resultsPath = join(runDir, 'results.jsonl');
  const stderrPath = join(runDir, 'logs', 'eval_stderr.log');

  mkdirSync(outputDir, { recursive: true });
  mkdirSync(join(runDir, 'logs'), { recursive: true });

  const env = {
    ...process.env,
    MODELS: options.model,
    TEST_FILTER: options.filter ?? '',
    CUSTOM_GUIDELINES_PATH: options.guidelinesPath,
    OUTPUT_TEMPDIR: outputDir,
    LOCAL_RESULTS: resultsPath,
    DISABLE_BRAINTRUST: '1',
    VERBOSE_INFO_LOGS: '1',
  };

  // Spawn Python runner with timeout
  await new Promise<void>((resolve, reject) => {
    const child = spawn('pdm', ['run', 'python', '-m', 'runner.eval_convex_coding'], {
      env,
      cwd: join(import.meta.dir, '..', '..'),
      stdio: ['inherit', 'inherit', 'pipe'], // Capture stderr
    });

    let stderr = '';
    child.stderr?.on('data', (data) => {
      stderr += data.toString();
      process.stderr.write(data); // Still show in console
    });

    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Eval runner timed out after ${EVAL_TIMEOUT_MS / 1000}s`));
    }, EVAL_TIMEOUT_MS);

    child.on('close', (code) => {
      clearTimeout(timeout);
      // Save stderr for debugging
      if (stderr) writeFileSync(stderrPath, stderr, 'utf-8');

      if (code === 0) resolve();
      else reject(new Error(`Python eval runner exited with code ${code}. Check ${stderrPath} for details.`));
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });

  return parseResults(resultsPath, outputDir);
}

function parseResults(resultsPath: string, outputDir: string): EvalRunResult {
  if (!existsSync(resultsPath)) {
    throw new Error(`Results file not found: ${resultsPath}`);
  }

  const lines = readFileSync(resultsPath, 'utf-8')
    .split('\n')
    .filter(line => line.trim());

  const results: EvalResult[] = [];
  let passed = 0;
  let failed = 0;

  for (const line of lines) {
    const record = JSON.parse(line);
    const evalName = record.input?.name ?? 'unknown';
    const isPassed = record.scores?.correctness === 1;

    if (isPassed) passed++;
    else failed++;

    // Find the eval output directory
    const evalDir = join(outputDir, evalName);
    const taskPath = join(evalDir, 'TASK.txt');
    const runLogPath = join(evalDir, 'run.log');

    // Find expected and output files
    const expectedFiles: string[] = [];
    const outputFiles: string[] = [];

    if (existsSync(evalDir)) {
      const expectedDir = join(evalDir, 'expected');
      const outputDirPath = join(evalDir, 'output');

      if (existsSync(expectedDir)) {
        expectedFiles.push(...readdirSync(expectedDir).map(f => join(expectedDir, f)));
      }

      if (existsSync(outputDirPath)) {
        outputFiles.push(...getAllFiles(outputDirPath));
      }
    }

    results.push({
      evalName,
      passed: isPassed,
      expectedFiles,
      outputFiles,
      runLogPath,
      taskPath,
    });
  }

  return {
    passed,
    failed,
    total: passed + failed,
    results,
  };
}

function getAllFiles(dir: string): string[] {
  const files: string[] = [];
  const entries = readdirSync(dir);

  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      files.push(...getAllFiles(fullPath));
    } else {
      files.push(fullPath);
    }
  }

  return files;
}
