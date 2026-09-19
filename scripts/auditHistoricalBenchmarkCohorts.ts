#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { join } from "node:path";

type StoredCodingRun = {
  kind?: "coding";
  _creationTime: number;
  plannedEvals: string[];
  experiment?: string;
  status: { kind: string };
};

type StoredDecisionRun = {
  kind: "decision";
  _creationTime: number;
};

type StoredRun = StoredCodingRun | StoredDecisionRun;

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

function parseProductionRuns(value: unknown): StoredRun[] {
  if (!Array.isArray(value)) {
    throw new Error("Expected Convex runs export to be an array");
  }
  return value.map((entry, index) => {
    if (entry === null || typeof entry !== "object") {
      throw new Error(`Run ${index} is not an object`);
    }
    const run = entry as Record<string, unknown>;
    if (typeof run._creationTime !== "number") {
      throw new Error(`Run ${index} has no numeric _creationTime`);
    }
    if (run.kind === "decision") {
      return { kind: "decision", _creationTime: run._creationTime };
    }
    if (run.kind !== undefined && run.kind !== "coding") {
      throw new Error(`Run ${index} has unknown kind ${String(run.kind)}`);
    }
    if (
      !Array.isArray(run.plannedEvals) ||
      !run.plannedEvals.every((evalPath) => typeof evalPath === "string")
    ) {
      throw new Error(`Coding run ${index} has invalid plannedEvals`);
    }
    if (
      run.status === null ||
      typeof run.status !== "object" ||
      typeof (run.status as Record<string, unknown>).kind !== "string"
    ) {
      throw new Error(`Coding run ${index} has invalid status`);
    }
    if (run.experiment !== undefined && typeof run.experiment !== "string") {
      throw new Error(`Coding run ${index} has invalid experiment`);
    }
    return {
      kind: run.kind,
      _creationTime: run._creationTime,
      plannedEvals: run.plannedEvals,
      experiment: run.experiment,
      status: { kind: (run.status as Record<string, unknown>).kind as string },
    };
  });
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
  return parseProductionRuns(JSON.parse(output) as unknown);
}

async function main(): Promise<void> {
  const storedRuns = await readProductionRuns();
  // Historical coding records may be untagged during phase 1. Select both
  // coding forms before any aggregation so decision rows cannot become cohorts.
  const runs = storedRuns.filter(
    (run): run is StoredCodingRun =>
      run.kind === undefined || run.kind === "coding",
  );
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
        decisionRunsExcluded: storedRuns.length - runs.length,
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
