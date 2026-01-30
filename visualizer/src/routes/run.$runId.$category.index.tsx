import { createFileRoute, useParams } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import { api } from "../../../evalScores/convex/_generated/api";
import type { Id } from "../../../evalScores/convex/_generated/dataModel";
import { getEvalStatusIcon, formatDuration } from "../lib/types";

export const Route = createFileRoute("/run/$runId/$category/")({
  component: CategoryOverviewPage,
});

function CategoryOverviewPage() {
  const { runId, category } = useParams({ from: "/run/$runId/$category/" });
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

  const categoryEvals = run.evals.filter((e) => e.category === category);
  const passed = categoryEvals.filter((e) => e.status.kind === "passed").length;
  const failed = categoryEvals.filter((e) => e.status.kind === "failed").length;
  const total = categoryEvals.length;
  const passRate = total > 0 ? (passed / total) * 100 : 0;

  return (
    <main className="flex-1 overflow-auto p-6">
      <div className="max-w-4xl mx-auto">
        <header className="mb-8">
          <h1 className="text-2xl font-bold text-white mb-2">
            {formatCategoryName(category)}
          </h1>
          <p className="text-slate-400">
            Select an evaluation from the sidebar to view details
          </p>
        </header>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
          <div className="stat-card overall-score">
            <div className="stat-number">{passRate.toFixed(1)}%</div>
            <div className="stat-label">Pass Rate</div>
          </div>
          <div className="stat-card pass-rate">
            <div className="stat-number text-green-400">{passed}</div>
            <div className="stat-label">Passed</div>
          </div>
          <div className="stat-card total-tests">
            <div className="stat-number text-red-400">{failed}</div>
            <div className="stat-label">Failed</div>
          </div>
          <div className="stat-card">
            <div className="stat-number">{total}</div>
            <div className="stat-label">Total</div>
          </div>
        </div>

        <div className="card">
          <div className="card-header">📋 Evaluations in {formatCategoryName(category)}</div>
          <div className="card-content">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Name</th>
                  <th>Duration</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {categoryEvals
                  .sort((a, b) => a.name.localeCompare(b.name))
                  .map((evalItem) => {
                    const duration =
                      evalItem.status.kind === "passed" ||
                      evalItem.status.kind === "failed"
                        ? formatDuration(evalItem.status.durationMs)
                        : "—";

                    return (
                      <tr key={evalItem._id}>
                        <td>
                          <span>{getEvalStatusIcon(evalItem.status)}</span>
                        </td>
                        <td className="text-white">{evalItem.name}</td>
                        <td className="text-slate-400">{duration}</td>
                        <td>
                          {evalItem.status.kind === "failed" && (
                            <span className="text-red-400 text-sm">
                              {evalItem.status.failureReason}
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </main>
  );
}

function formatCategoryName(category: string): string {
  return category
    .replace(/^\d+-/, "")
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
