import { createFileRoute, useParams } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import { api } from "../../../evalScores/convex/_generated/api";
import type { Id } from "../../../evalScores/convex/_generated/dataModel";
import {
  getRunStatusIcon,
  getEvalStatusIcon,
  formatDuration,
  type Eval,
} from "../lib/types";

export const Route = createFileRoute("/run/$runId/")({
  component: RunOverviewPage,
});

function RunOverviewPage() {
  const { runId } = useParams({ from: "/run/$runId/" });
  const run = useQuery(api.runs.getRunDetails, {
    runId: runId as Id<"runs">,
  });

  if (run === undefined) {
    return (
      <main className="flex-1 overflow-auto p-6">
        <div className="text-slate-400">Loading...</div>
      </main>
    );
  }

  if (run === null) {
    return (
      <main className="flex-1 overflow-auto p-6">
        <div className="text-red-400">Run not found</div>
      </main>
    );
  }

  // Calculate stats
  const passedEvals = run.evals.filter((e) => e.status.kind === "passed").length;
  const failedEvals = run.evals.filter((e) => e.status.kind === "failed").length;
  const totalEvals = run.evals.length;
  const passRate = totalEvals > 0 ? passedEvals / totalEvals : 0;

  // Group by category
  const categoryStats = new Map<
    string,
    { passed: number; failed: number; total: number }
  >();
  for (const evalItem of run.evals) {
    const cat = evalItem.category;
    if (!categoryStats.has(cat)) {
      categoryStats.set(cat, { passed: 0, failed: 0, total: 0 });
    }
    const stats = categoryStats.get(cat)!;
    stats.total++;
    if (evalItem.status.kind === "passed") stats.passed++;
    if (evalItem.status.kind === "failed") stats.failed++;
  }

  return (
    <main className="flex-1 overflow-auto p-6">
      <div className="max-w-6xl mx-auto">
        <header className="mb-8">
          <div className="flex items-center gap-3 mb-2">
            <span className="text-3xl">{getRunStatusIcon(run.status)}</span>
            <h1 className="text-3xl font-bold text-white">{run.model}</h1>
          </div>
          <p className="text-slate-400">
            {run.provider && <span>{run.provider} · </span>}
            {new Date(run._creationTime).toLocaleString()}
            {(run.status.kind === "completed" || run.status.kind === "failed") && (
              <span> · {formatDuration(run.status.durationMs)}</span>
            )}
          </p>
        </header>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
          <div className="stat-card overall-score">
            <div className="stat-number">{(passRate * 100).toFixed(1)}%</div>
            <div className="stat-label">Pass Rate</div>
          </div>
          <div className="stat-card pass-rate">
            <div className="stat-number text-green-400">{passedEvals}</div>
            <div className="stat-label">Passed</div>
          </div>
          <div className="stat-card total-tests">
            <div className="stat-number text-red-400">{failedEvals}</div>
            <div className="stat-label">Failed</div>
          </div>
          <div className="stat-card">
            <div className="stat-number">{totalEvals}</div>
            <div className="stat-label">Total Evals</div>
          </div>
        </div>

        <div className="card mb-8">
          <div className="card-header">📋 Category Breakdown</div>
          <div className="card-content">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Category</th>
                  <th>Pass Rate</th>
                  <th>Passed</th>
                  <th>Failed</th>
                  <th>Total</th>
                </tr>
              </thead>
              <tbody>
                {Array.from(categoryStats.entries())
                  .sort(([a], [b]) => a.localeCompare(b))
                  .map(([category, stats]) => {
                    const percentage =
                      stats.total > 0
                        ? ((stats.passed / stats.total) * 100).toFixed(1)
                        : "0.0";
                    const icon =
                      stats.passed === stats.total
                        ? "✅"
                        : stats.failed === stats.total
                          ? "❌"
                          : "⚠️";

                    return (
                      <tr key={category}>
                        <td>
                          <span className="mr-2">{icon}</span>
                          {formatCategoryName(category)}
                        </td>
                        <td>
                          <div className="score-bar-container w-24">
                            <div
                              className="score-bar"
                              style={{ width: `${percentage}%` }}
                            />
                            <span className="score-text">{percentage}%</span>
                          </div>
                        </td>
                        <td className="text-green-400">{stats.passed}</td>
                        <td className="text-red-400">{stats.failed}</td>
                        <td>{stats.total}</td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card">
          <div className="card-header">📊 All Evals</div>
          <div className="card-content">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Eval</th>
                  <th>Category</th>
                  <th>Duration</th>
                </tr>
              </thead>
              <tbody>
                {run.evals
                  .sort((a, b) => a.evalPath.localeCompare(b.evalPath))
                  .map((evalItem) => (
                    <EvalRow key={evalItem._id} evalItem={evalItem} />
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </main>
  );
}

function EvalRow({ evalItem }: { evalItem: Eval }) {
  const duration =
    evalItem.status.kind === "passed" || evalItem.status.kind === "failed"
      ? formatDuration(evalItem.status.durationMs)
      : "—";

  return (
    <tr>
      <td>
        <span>{getEvalStatusIcon(evalItem.status)}</span>
      </td>
      <td className="text-white">{evalItem.name}</td>
      <td className="text-slate-400">{formatCategoryName(evalItem.category)}</td>
      <td className="text-slate-500">{duration}</td>
    </tr>
  );
}

function formatCategoryName(category: string): string {
  return category
    .replace(/^\d+-/, "")
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
