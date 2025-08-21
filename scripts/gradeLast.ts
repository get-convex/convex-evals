// Reads the last entry from local_results.jsonl, extracts `tempdir`, and runs the grader
import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";

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

function printConciseFailureFromRunLogs(tempdir: string) {
  try {
    const outputRoot = join(tempdir, "output");
    if (!existsSync(outputRoot)) return;
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
          const projectDir = join(catDir, name);
          const logPath = join(projectDir, "run.log");
          if (!existsSync(logPath)) continue;
          const log = readFileSync(logPath, { encoding: "utf-8" });
          const lines = log.split(/\r?\n/);
          let printed = false;
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const marker = "[error] vitest:";
            if (line.includes(marker)) {
              if (!printed) {
                console.log(`- ${category}/${name}:`);
                printed = true;
              }
              // Print the marker line trimmed, then subsequent non-prefixed lines as the failure block
              console.log(line.replace(marker, "  ").trimEnd());
              let j = i + 1;
              while (
                j < lines.length &&
                lines[j] &&
                !/^\[.+\]/.test(lines[j])
              ) {
                console.log(`  ${lines[j]}`);
                j++;
              }
              i = j - 1;
            }
          }
          if (printed) console.log(`\nSee full log: ${logPath}\n`);
        }
      }
    }
  } catch {
    // best-effort only
  }
}

try {
  const resultsPath = resolve(process.cwd(), "local_results.jsonl");
  const tempdir = readLastTempdir(resultsPath);
  const stat = existsSync(tempdir) ? statSync(tempdir) : null;
  if (!stat || !stat.isDirectory())
    throw new Error(`Tempdir not found or not a directory: ${tempdir}`);

  console.log(`Grading last run in: ${tempdir}`);
  const concise = process.argv.includes("--concise");
  if (concise) {
    const res = Bun.spawnSync([
      "pdm",
      "run",
      "python",
      "-m",
      "runner.run_grader",
      tempdir,
    ]);
    const dec = new TextDecoder();
    const out = dec.decode(res.stdout) + dec.decode(res.stderr);
    const interesting = out
      .split(/\r?\n/)
      .filter(
        (l) =>
          l.startsWith("Running grader for ") ||
          l.startsWith("Grading ") ||
          l.trim().startsWith("- Tests fail:") ||
          l.startsWith("Result "),
      );
    for (const l of interesting) console.log(l);
    if (res.exitCode !== 0) {
      console.log("\nConcise failure details:");
      printConciseFailureFromRunLogs(tempdir);
      process.exit(res.exitCode || 1);
    }
  } else {
    const p = Bun.spawn(
      ["pdm", "run", "python", "-m", "runner.run_grader", tempdir],
      { stdio: ["inherit", "inherit", "inherit"] },
    );
    const code = await p.exited;
    if (code !== 0) process.exit(code);
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
