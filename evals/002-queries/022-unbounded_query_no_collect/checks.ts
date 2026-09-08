import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

export function inspectBoundedQuery(projectDir: string): { bounds: number[] } {
  const result = spawnSync(
    "bun",
    [
      "--no-env-file",
      fileURLToPath(new URL("./inspect.mjs", import.meta.url)),
      projectDir,
      `workspace-${randomUUID()}`,
    ],
    {
      // The generated handler runs in a separate process without runner keys.
      env: { PATH: process.env.PATH },
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 1_000_000,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `Bounded query check failed: ${result.stderr || result.stdout}`,
    );
  }
  // Allow ordinary console logging in the generated handler.
  const report = result.stdout
    .split("\n")
    .reverse()
    .find((line) => line.startsWith("BOUNDED_QUERY:"));
  if (!report) throw new Error("Bounded query check did not finish");
  return JSON.parse(report.slice("BOUNDED_QUERY:".length)) as {
    bounds: number[];
  };
}
