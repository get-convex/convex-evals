// Run Convex codegen in every eval's answer project
import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function listCategories(root: string): string[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

function listEvals(catDir: string): string[] {
  return readdirSync(catDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

function getArgValue(flag: string): string | undefined {
  const pref = `${flag}=`;
  for (const a of process.argv.slice(2))
    if (a.startsWith(pref)) return a.slice(pref.length);
  return undefined;
}

function shouldInclude(
  category: string,
  name: string,
  filter: string | undefined,
): boolean {
  if (!filter) return true;
  try {
    const rx = new RegExp(filter);
    return rx.test(`${category}/${name}`);
  } catch {
    return `${category}/${name}`.includes(filter);
  }
}

async function runCodegen(cwd: string): Promise<number> {
  const p = Bun.spawn(["bunx", "--yes", "convex", "codegen"], {
    cwd,
    stdio: ["inherit", "inherit", "inherit"],
  });
  return await p.exited;
}

async function main() {
  const repoRoot = process.cwd();
  const evalsRoot = resolve(repoRoot, "evals");
  const filter = getArgValue("--filter") ?? process.env.TEST_FILTER;

  if (!isDirectory(evalsRoot)) {
    console.error(`Missing evals directory at ${evalsRoot}`);
    process.exit(1);
  }

  console.log(`Scanning evals at ${evalsRoot}`);
  if (filter) console.log(`Filter: ${filter}`);

  let found = 0;
  let attempted = 0;
  let succeeded = 0;
  const failures: { path: string; code: number }[] = [];

  for (const category of listCategories(evalsRoot)) {
    const catDir = join(evalsRoot, category);
    for (const name of listEvals(catDir)) {
      if (!shouldInclude(category, name, filter)) continue;
      const answerDir = join(catDir, name, "answer");
      if (!isDirectory(answerDir)) continue;
      found++;

      console.log(`- Running codegen in ${category}/${name} ...`);
      attempted++;
      const exitCode = await runCodegen(answerDir);
      if (exitCode === 0) {
        succeeded++;
      } else {
        failures.push({ path: `${category}/${name}`, code: exitCode });
      }
    }
  }

  console.log(`\nSummary:`);
  console.log(`- Answers discovered: ${found}`);
  console.log(`- Codegen attempted: ${attempted}`);
  console.log(`- Succeeded: ${succeeded}`);
  console.log(`- Failed: ${failures.length}`);
  if (failures.length > 0) {
    for (const f of failures) console.log(`  * ${f.path} (exit ${f.code})`);
    process.exit(1);
  }
}

// eslint-disable-next-line @typescript-eslint/no-floating-promises
main();
