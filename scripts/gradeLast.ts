// Grade the last run using the tempdir recorded in local_results.jsonl
import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";

const RESULTS_FILE = resolve(process.cwd(), "local_results.jsonl");
const ERROR_MARKER = "[error] vitest:";

// -------- JSONL helpers --------
function readJsonlLines(filePath: string): string[] {
  if (!existsSync(filePath))
    throw new Error(`Results file not found: ${filePath}`);
  const content = readFileSync(filePath, { encoding: "utf-8" });
  const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) throw new Error("Results file is empty");
  return lines;
}

function parseLastTempdirFromJsonl(lines: string[]): string {
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(lines[i]) as any;
      if (!obj || typeof obj !== "object") continue;
      if (typeof obj.tempdir === "string") return obj.tempdir;
      if (
        obj.summary?.metadata?.tempdir &&
        typeof obj.summary.metadata.tempdir === "string"
      )
        return obj.summary.metadata.tempdir;
    } catch {
      // ignore parse errors and scan upwards
    }
  }
  throw new Error("No tempdir found in local results");
}

// -------- Filesystem helpers --------
function assertDirectory(path: string): void {
  const st = existsSync(path) ? statSync(path) : null;
  if (!st || !st.isDirectory())
    throw new Error(`Tempdir not found or not a directory: ${path}`);
}

// -------- Grader runners --------
function runGraderConcise(tempdir: string): {
  exitCode: number;
  output: string;
} {
  const res = Bun.spawnSync([
    "pdm",
    "run",
    "python",
    "-m",
    "runner.run_grader",
    tempdir,
  ]);
  const dec = new TextDecoder();
  const output =
    (res.stdout ? dec.decode(res.stdout) : "") +
    (res.stderr ? dec.decode(res.stderr) : "");
  return { exitCode: res.exitCode ?? 1, output };
}

async function runGraderStreaming(tempdir: string): Promise<number> {
  const p = Bun.spawn(
    ["pdm", "run", "python", "-m", "runner.run_grader", tempdir],
    {
      stdio: ["inherit", "inherit", "inherit"],
    },
  );
  return await p.exited;
}

// -------- Output parsing/printing --------
function extractInterestingLines(output: string): string[] {
  return output
    .split(/\r?\n/)
    .filter(
      (l) =>
        l.startsWith("Running grader for ") ||
        l.startsWith("Grading ") ||
        l.trim().startsWith("- Tests fail:") ||
        l.startsWith("Result "),
    );
}

type FailureEntry = {
  category: string;
  name: string;
  messages: string[];
  logPath: string;
};

function listProjectLogPaths(
  tempdir: string,
): { category: string; name: string; logPath: string }[] {
  const out: { category: string; name: string; logPath: string }[] = [];
  const outputRoot = join(tempdir, "output");
  if (!existsSync(outputRoot)) return out;
  const models = readdirSync(outputRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  for (const model of models) {
    const modelDir = join(outputRoot, model);
    const categories = readdirSync(modelDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    for (const category of categories) {
      const catDir = join(modelDir, category);
      const names = readdirSync(catDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
      for (const name of names) {
        const logPath = join(catDir, name, "run.log");
        if (existsSync(logPath)) out.push({ category, name, logPath });
      }
    }
  }
  return out;
}

function parseVitestFailuresFromLog(logPath: string): string[] {
  const log = readFileSync(logPath, { encoding: "utf-8" });
  const lines = log.split(/\r?\n/);
  const messages: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes(ERROR_MARKER)) continue;
    messages.push(line.replace(ERROR_MARKER, "  ").trimEnd());
    let j = i + 1;
    while (j < lines.length && lines[j] && !/^\[.+\]/.test(lines[j])) {
      messages.push(`  ${lines[j]}`);
      j++;
    }
    i = j - 1;
  }
  return messages;
}

function collectConciseFailures(tempdir: string): FailureEntry[] {
  const entries: FailureEntry[] = [];
  for (const { category, name, logPath } of listProjectLogPaths(tempdir)) {
    const messages = parseVitestFailuresFromLog(logPath);
    if (messages.length > 0)
      entries.push({ category, name, messages, logPath });
  }
  return entries;
}

function printConciseFailures(failures: FailureEntry[]): void {
  if (failures.length === 0) return;
  console.log("\nConcise failure details:");
  for (const f of failures) {
    console.log(`- ${f.category}/${f.name}:`);
    for (const m of f.messages) console.log(m);
    console.log(`\nSee full log: ${f.logPath}\n`);
  }
}

// -------- Main --------
try {
  const tempdir = parseLastTempdirFromJsonl(readJsonlLines(RESULTS_FILE));
  assertDirectory(tempdir);

  const concise = process.argv.includes("--concise");
  if (concise) {
    const { exitCode, output } = runGraderConcise(tempdir);
    for (const l of extractInterestingLines(output)) console.log(l);
    if (exitCode !== 0) {
      printConciseFailures(collectConciseFailures(tempdir));
      process.exit(exitCode || 1);
    }
  } else {
    const code = await runGraderStreaming(tempdir);
    if (code !== 0) process.exit(code);
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
