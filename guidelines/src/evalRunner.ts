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

  const content = readFileSync(resultsPath, 'utf-8').trim();
  
  // Handle multi-line JSONL: the file may contain multiple JSON objects (one per run)
  // We want the LAST one (most recent run)
  const lines = content.split('\n').filter(line => line.trim());
  
  if (lines.length === 0) {
    throw new Error(`Results file is empty: ${resultsPath}`);
  }
  
  // Take the last line (most recent run results)
  const lastLine = lines[lines.length - 1];
  
  let data: unknown;
  try {
    data = JSON.parse(lastLine);
  } catch (err) {
    throw new Error(`Failed to parse results JSON from ${resultsPath}: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Handle summary format with individual_results array
  if (isObject(data) && 'individual_results' in data && Array.isArray(data.individual_results)) {
    return parseSummaryFormat(data as unknown as SummaryResult, outputDir);
  }

  // Fall back to JSONL format (multiple lines, each a separate result - old braintrust format)
  return parseJsonlFormat(content, outputDir);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface SummaryResult {
  individual_results: Array<{
    category: string;
    name: string;
    passed: boolean;
    failure_reason: string | null;
    directory_path: string;
  }>;
  run_stats: {
    total_tests: number;
    total_passed: number;
    total_failed: number;
  };
}

function parseSummaryFormat(data: SummaryResult, outputDir: string): EvalRunResult {
  const results: EvalResult[] = [];

  for (const item of data.individual_results) {
    const evalName = `${item.category}/${item.name}`;
    const evalDir = join(outputDir, 'output', item.directory_path.split('/').pop() ?? '', item.category, item.name);
    
    // Try multiple possible paths for eval output
    const possibleDirs = [
      join(outputDir, evalName),
      item.directory_path,
    ];
    
    let actualEvalDir = possibleDirs.find(d => existsSync(d)) ?? evalDir;

    const taskPath = join(actualEvalDir, 'TASK.txt');
    const runLogPath = join(actualEvalDir, 'run.log');

    const expectedFiles: string[] = [];
    const outputFiles: string[] = [];

    if (existsSync(actualEvalDir)) {
      const expectedDir = join(actualEvalDir, 'expected');
      const outputDirPath = join(actualEvalDir, 'output');

      if (existsSync(expectedDir)) {
        expectedFiles.push(...readdirSync(expectedDir).map(f => join(expectedDir, f)));
      }

      if (existsSync(outputDirPath)) {
        outputFiles.push(...getAllFiles(outputDirPath));
      }
    }

    results.push({
      evalName,
      passed: item.passed,
      expectedFiles,
      outputFiles,
      runLogPath,
      taskPath,
    });
  }

  return {
    passed: data.run_stats.total_passed,
    failed: data.run_stats.total_failed,
    total: data.run_stats.total_tests,
    results,
  };
}

function parseJsonlFormat(content: string, outputDir: string): EvalRunResult {
  const lines = content.split('\n').filter(line => line.trim());

  const results: EvalResult[] = [];
  let passed = 0;
  let failed = 0;

  for (const line of lines) {
    const record = JSON.parse(line);
    const evalName = record.input?.name ?? 'unknown';
    const isPassed = record.scores?.correctness === 1;

    if (isPassed) passed++;
    else failed++;

    const evalDir = join(outputDir, evalName);
    const taskPath = join(evalDir, 'TASK.txt');
    const runLogPath = join(evalDir, 'run.log');

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
