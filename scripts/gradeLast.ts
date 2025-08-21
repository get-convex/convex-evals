// Reads the last entry from local_results.jsonl, extracts `tempdir`, and runs the grader
import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

function readLastTempdir(resultsPath: string): string {
  if (!existsSync(resultsPath))
    throw new Error(`Results file not found: ${resultsPath}`);
  const lines = readFileSync(resultsPath, { encoding: "utf-8" })
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0);
  if (lines.length === 0) throw new Error("Results file is empty");

  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i]) as any;
      if (parsed && typeof parsed === "object") {
        if (typeof parsed.tempdir === "string") return parsed.tempdir;
        if (
          parsed.summary?.metadata?.tempdir &&
          typeof parsed.summary.metadata.tempdir === "string"
        )
          return parsed.summary.metadata.tempdir;
      }
    } catch {
      // ignore parse errors
    }
  }
  throw new Error("No tempdir found in local results");
}

try {
  const resultsPath = resolve(process.cwd(), "local_results.jsonl");
  const tempdir = readLastTempdir(resultsPath);
  const stat = existsSync(tempdir) ? statSync(tempdir) : null;
  if (!stat || !stat.isDirectory())
    throw new Error(`Tempdir not found or not a directory: ${tempdir}`);

  console.log(`Grading last run in: ${tempdir}`);
  const p = Bun.spawn(
    ["pdm", "run", "python", "-m", "runner.run_grader", tempdir],
    { stdio: ["inherit", "inherit", "inherit"] },
  );
  const code = await p.exited;
  if (code !== 0) process.exit(code);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
