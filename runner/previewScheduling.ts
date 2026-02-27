#!/usr/bin/env bun
/**
 * Preview the auto-scheduling formula against production data.
 *
 * Queries the production Convex backend for scheduling stats, applies the
 * interval formula, and prints two tables:
 *
 *   Table A - Current state: computed target interval and "due today?" per model
 *   Table B - Projection: how the interval changes as runs accumulate (at current stdDev)
 *
 * Usage:
 *   bun run runner/previewScheduling.ts
 */
import { ConvexHttpClient } from "convex/browser";
import { api } from "../evalScores/convex/_generated/api.js";
import { ALL_MODELS } from "./models/index.js";

// ── Constants (must match listModels.ts once implemented) ─────────────

const BOOTSTRAP_RUNS = 5;
const TARGET_RUNS = 20;
const BASE_INTERVAL = 30; // days
const MIN_INTERVAL = 2;
const VARIANCE_NORM = 0.05;
const RETIRE_AGE_DAYS = 180;

const PROD_CONVEX_URL = "https://fabulous-panther-525.convex.cloud";

// ── Formula ──────────────────────────────────────────────────────────

function computeTargetDays(
  completedRuns: number,
  stdDev: number,
  daysSinceFirstRun: number | null,
): number {
  if (completedRuns < BOOTSTRAP_RUNS) return MIN_INTERVAL;

  if (daysSinceFirstRun !== null && daysSinceFirstRun > RETIRE_AGE_DAYS) {
    return Infinity;
  }

  const dataConfidence = Math.min(completedRuns / TARGET_RUNS, 1.0);
  const variancePenalty = stdDev / VARIANCE_NORM;
  return Math.max(
    MIN_INTERVAL,
    (BASE_INTERVAL * dataConfidence) / (1 + variancePenalty),
  );
}

// ── Formatting helpers ────────────────────────────────────────────────

function fmtDays(d: number): string {
  if (!isFinite(d)) return "RETIRED";
  return `${Math.round(d)}d`;
}

function fmtAge(ms: number | null): string {
  if (ms === null) return "N/A";
  return `${Math.round((Date.now() - ms) / 86_400_000)}d`;
}

function col(s: string, width: number): string {
  return s.padEnd(width).slice(0, width);
}

function rCol(s: string, width: number): string {
  return s.padStart(width).slice(-width);
}

// ── Main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const url = process.env.CONVEX_EVAL_URL ?? PROD_CONVEX_URL;
  console.log(`\nQuerying Convex: ${url}\n`);

  const client = new ConvexHttpClient(url);

  const modelNames = ALL_MODELS.map((m) => m.name);
  const stats = await client.query(api.runs.getSchedulingStats, {
    models: modelNames,
  });

  const statsByModel = new Map(stats.map((s) => [s.model, s]));
  const now = Date.now();

  // ── Table A: Current state ──────────────────────────────────────────
  console.log("═".repeat(110));
  console.log("TABLE A  -  Current State");
  console.log("═".repeat(110));
  console.log(
    col("Model", 30) +
      rCol("Runs", 6) +
      rCol("StdDev", 8) +
      rCol("Age(d)", 8) +
      rCol("Target", 8) +
      rCol("LastRun", 9) +
      "  " +
      col("Due today?", 12) +
      "  Current override",
  );
  console.log("─".repeat(110));

  for (const model of ALL_MODELS) {
    const s = statsByModel.get(model.name);
    if (!s) continue;

    const daysSinceFirst =
      s.firstRunTime !== null
        ? (now - s.firstRunTime) / 86_400_000
        : null;
    const daysSinceLast =
      s.lastRunTime !== null
        ? (now - s.lastRunTime) / 86_400_000
        : null;

    const targetDays = computeTargetDays(
      s.completedRunCount,
      s.scoreStdDev,
      daysSinceFirst,
    );

    const dueToday =
      daysSinceLast === null || daysSinceLast >= targetDays ? "YES" : "no";

    const override =
      model.ciRunFrequency !== undefined ? model.ciRunFrequency : "(none - auto)";

    console.log(
      col(model.formattedName, 30) +
        rCol(String(s.completedRunCount), 6) +
        rCol(s.scoreStdDev.toFixed(3), 8) +
        rCol(fmtAge(s.firstRunTime), 8) +
        rCol(fmtDays(targetDays), 8) +
        rCol(daysSinceLast !== null ? `${Math.round(daysSinceLast)}d` : "never", 9) +
        "  " +
        col(dueToday, 12) +
        "  " +
        override,
    );
  }

  // ── Table B: Projections ────────────────────────────────────────────
  console.log("\n");
  console.log("═".repeat(90));
  console.log(
    "TABLE B  -  Projected Target Interval as Runs Accumulate  (at current stdDev, age ignored)",
  );
  console.log("═".repeat(90));
  console.log(
    col("Model", 30) +
      rCol("StdDev", 8) +
      rCol("@3runs", 8) +
      rCol("@5runs", 8) +
      rCol("@10runs", 9) +
      rCol("@15runs", 9) +
      rCol("@20runs", 9) +
      rCol("@30runs", 9),
  );
  console.log("─".repeat(90));

  for (const model of ALL_MODELS) {
    const s = statsByModel.get(model.name);
    if (!s) continue;

    // For projection, treat age as 0 (not retired) so we see the formula's shape
    const project = (runs: number): string =>
      fmtDays(computeTargetDays(runs, s.scoreStdDev, 0));

    console.log(
      col(model.formattedName, 30) +
        rCol(s.scoreStdDev.toFixed(3), 8) +
        rCol(project(3), 8) +
        rCol(project(5), 8) +
        rCol(project(10), 9) +
        rCol(project(15), 9) +
        rCol(project(20), 9) +
        rCol(project(30), 9),
    );
  }

  console.log("\n");
  console.log("Formula constants:");
  console.log(
    `  BOOTSTRAP_RUNS=${BOOTSTRAP_RUNS}  TARGET_RUNS=${TARGET_RUNS}  BASE_INTERVAL=${BASE_INTERVAL}d  MIN_INTERVAL=${MIN_INTERVAL}d  VARIANCE_NORM=${VARIANCE_NORM}  RETIRE_AGE_DAYS=${RETIRE_AGE_DAYS}d`,
  );
  console.log();
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
