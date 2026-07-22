#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { join } from "node:path";

type StoredRun = {
  _creationTime: number;
  plannedEvals: string[];
  experiment?: string;
  status: { kind: string };
};

type Cohort = {
  signature: string;
  evalCount: number;
  firstRunAt: number;
  lastRunAt: number;
  runCount: number;
  defaultRuns: number;
  noGuidelinesRuns: number;
  statuses: Record<string, number>;
};

function suiteSignature(plannedEvals: string[]): string {
  return createHash("sha256")
    .update([...plannedEvals].sort().join("\0"))
    .digest("hex")
    .slice(0, 12);
}

function formatDate(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

async function readProductionRuns(): Promise<StoredRun[]> {
  const projectRoot = join(import.meta.dir, "..");
  const child = Bun.spawn(
    [
      process.execPath,
      "x",
      "convex",
      "data",
      "runs",
      "--prod",
      "--limit",
      "9999",
      "--format",
      "jsonArray",
    ],
    {
      cwd: join(projectRoot, "evalScores"),
      stdout: "pipe",
      stderr: "inherit",
    },
  );
  const output = await new Response(child.stdout).text();
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    throw new Error(`convex data exited with status ${exitCode}`);
  }
  return JSON.parse(output) as StoredRun[];
}

async function main(): Promise<void> {
  const runs = await readProductionRuns();
  const cohorts = new Map<string, Cohort>();

  for (const run of runs) {
    const signature = suiteSignature(run.plannedEvals);
    const cohort = cohorts.get(signature) ?? {
      signature,
      evalCount: run.plannedEvals.length,
      firstRunAt: run._creationTime,
      lastRunAt: run._creationTime,
      runCount: 0,
      defaultRuns: 0,
      noGuidelinesRuns: 0,
      statuses: {},
    };
    cohort.firstRunAt = Math.min(cohort.firstRunAt, run._creationTime);
    cohort.lastRunAt = Math.max(cohort.lastRunAt, run._creationTime);
    cohort.runCount += 1;
    if (run.experiment === "no_guidelines") {
      cohort.noGuidelinesRuns += 1;
    } else if (run.experiment === undefined) {
      cohort.defaultRuns += 1;
    }
    cohort.statuses[run.status.kind] =
      (cohort.statuses[run.status.kind] ?? 0) + 1;
    cohorts.set(signature, cohort);
  }

  const likelyFullSuites = [...cohorts.values()]
    .filter((cohort) => cohort.evalCount >= 20 && cohort.runCount >= 2)
    .sort((a, b) => a.firstRunAt - b.firstRunAt);
  const partialRuns = [...cohorts.values()]
    .filter((cohort) => !likelyFullSuites.includes(cohort))
    .reduce((sum, cohort) => sum + cohort.runCount, 0);

  console.log(
    JSON.stringify(
      {
        totalRuns: runs.length,
        uniquePlannedEvalSets: cohorts.size,
        likelyFullSuiteCohorts: likelyFullSuites.map((cohort) => ({
          signature: cohort.signature,
          evalCount: cohort.evalCount,
          firstRunAt: cohort.firstRunAt,
          lastRunAt: cohort.lastRunAt,
          firstRunDate: formatDate(cohort.firstRunAt),
          lastRunDate: formatDate(cohort.lastRunAt),
          runCount: cohort.runCount,
          defaultRuns: cohort.defaultRuns,
          noGuidelinesRuns: cohort.noGuidelinesRuns,
          statuses: cohort.statuses,
        })),
        partialOrOneOffCohorts: [...cohorts.values()]
          .filter((cohort) => !likelyFullSuites.includes(cohort))
          .map((cohort) => ({
            signature: cohort.signature,
            evalCount: cohort.evalCount,
            firstRunAt: cohort.firstRunAt,
            firstRunDate: formatDate(cohort.firstRunAt),
            runCount: cohort.runCount,
            statuses: cohort.statuses,
          })),
        partialOrOneOffRuns: partialRuns,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
