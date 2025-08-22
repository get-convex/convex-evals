// Prepare answer projects into a tempdir and run the grader against them
import {
  mkdirSync,
  existsSync,
  readdirSync,
  statSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";

// -------- CLI/env --------
function getArgValue(flag: string): string | undefined {
  const pref = `${flag}=`;
  for (const a of process.argv.slice(2))
    if (a.startsWith(pref)) return a.slice(pref.length);
  return undefined;
}

const filterArg = getArgValue("--filter");
const modelLabel = getArgValue("--model") ?? process.env.MODEL ?? "answers";

const TEST_FILTER = filterArg ?? process.env.TEST_FILTER ?? "";

// -------- Filesystem helpers --------
function ensureDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function listCategories(): string[] {
  const root = resolve(process.cwd(), "evals");
  if (!isDirectory(root)) throw new Error(`Missing evals directory at ${root}`);
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

function listEvals(category: string): string[] {
  const catDir = resolve(process.cwd(), "evals", category);
  return readdirSync(catDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

function shouldInclude(category: string, name: string): boolean {
  if (!TEST_FILTER) return true;
  try {
    const rx = new RegExp(TEST_FILTER);
    return rx.test(`${category}/${name}`);
  } catch {
    // Treat invalid regex as literal substring
    return `${category}/${name}`.includes(TEST_FILTER);
  }
}

function walkAnswerFiles(
  answerDir: string,
  baseDir: string,
  out: string[] = [],
): string[] {
  for (const entry of readdirSync(answerDir, { withFileTypes: true })) {
    const full = join(answerDir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "_generated")
        continue;
      walkAnswerFiles(full, baseDir, out);
    } else {
      if (entry.name === "package.json" || entry.name.endsWith(".ts")) {
        const relative = full.slice(baseDir.length + 1);
        out.push(relative);
      }
    }
  }
  return out;
}

function copyFileEnsuringDir(src: string, dest: string): void {
  ensureDir(dirname(dest));
  writeFileSync(dest, readFileSync(src));
}

function copyAnswerToOutput(
  tempdir: string,
  model: string,
  category: string,
  name: string,
): number {
  const evalDir = resolve(process.cwd(), "evals", category, name);
  const answerDir = join(evalDir, "answer");
  if (!isDirectory(answerDir)) return 0;

  const destProjectDir = join(tempdir, "output", model, category, name);
  ensureDir(destProjectDir);

  const files = walkAnswerFiles(answerDir, answerDir);
  for (const rel of files) {
    const src = join(answerDir, rel);
    const dest = join(destProjectDir, rel);
    copyFileEnsuringDir(src, dest);
  }
  return files.length;
}

// -------- Grader runner (full streaming) --------
async function runGraderStreaming(tempdir: string): Promise<number> {
  const p = Bun.spawn(
    ["pdm", "run", "python", "-m", "runner.run_grader", tempdir],
    { stdio: ["inherit", "inherit", "inherit"] },
  );
  return await p.exited;
}

// -------- Main --------
async function main() {
  try {
    const tempBase = Bun.nanoseconds().toString(36);
    const absTempdir = join(tmpdir(), "convex-evals", tempBase);
    ensureDir(absTempdir);
    ensureDir(join(absTempdir, "output"));
    ensureDir(join(absTempdir, "answer"));
    ensureDir(join(absTempdir, "backends"));

    console.log(
      `Initialized workspace: model='${modelLabel}', filter='${
        TEST_FILTER || "<none>"
      }'`,
    );
    console.log(`Workspace prepared at: ${absTempdir}`);

    let prepared = 0;
    const categories = listCategories();
    console.log(
      `Scanning categories under ${resolve(process.cwd(), "evals")}: ${categories.length} found`,
    );
    for (const category of categories) {
      console.log(`Processing category: ${category}`);
      for (const name of listEvals(category)) {
        if (!shouldInclude(category, name)) continue;
        console.log(`  - Preparing ${category}/${name}`);
        const count = copyAnswerToOutput(
          absTempdir,
          modelLabel,
          category,
          name,
        );
        if (count > 0) {
          console.log(`    Copied ${count} file(s)`);
          prepared++;
        } else {
          console.log(`    Skipped (no answer directory)`);
        }
      }
    }

    console.log(`Using tempdir: ${absTempdir}`);
    console.log(`Prepared ${prepared} project(s) under output/${modelLabel}`);
    if (prepared === 0) {
      console.log("No projects matched the filter or had an answer directory");
      process.exit(0);
    }

    console.log("Starting grader run...");
    const code = await runGraderStreaming(absTempdir);
    console.log(`Grader finished with exit code: ${code}`);
    if (code !== 0) process.exit(code || 1);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

// Execute
// eslint-disable-next-line @typescript-eslint/no-floating-promises
main();
