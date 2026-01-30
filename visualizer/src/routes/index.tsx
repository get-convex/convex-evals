import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import { api } from "../../../evalScores/convex/_generated/api";
import {
  getScoreStatus,
  getRunStatusIcon,
  formatDuration,
  type Run,
} from "../lib/types";

export const Route = createFileRoute("/")({
  component: RunsListPage,
});

function RunsListPage() {
  const runs = useQuery(api.runs.listRuns, {});

  if (runs === undefined) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="text-slate-400">Loading runs...</div>
      </div>
    );
  }

  return (
    <div className="flex h-screen">
      <Sidebar runs={runs} selectedRunId={null} />
      <main className="flex-1 overflow-auto p-6">
        <div className="max-w-6xl mx-auto">
          <header className="mb-8">
            <h1 className="text-3xl font-bold text-white mb-2">
              🚀 Convex Evaluation Results
            </h1>
            <p className="text-slate-400">
              Select a run from the sidebar to view detailed results
            </p>
          </header>

          <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
            <div className="stat-card">
              <div className="stat-number">{runs.length}</div>
              <div className="stat-label">Total Runs</div>
            </div>
            <div className="stat-card">
              <div className="stat-number">
                {runs.filter((r) => r.status.kind === "completed").length}
              </div>
              <div className="stat-label">Completed</div>
            </div>
            <div className="stat-card">
              <div className="stat-number">
                {runs.filter((r) => r.status.kind === "running" || r.status.kind === "pending").length}
              </div>
              <div className="stat-label">In Progress</div>
            </div>
            <div className="stat-card">
              <div className="stat-number">
                {new Set(runs.map((r) => r.model)).size}
              </div>
              <div className="stat-label">Models</div>
            </div>
          </div>

          <div className="card">
            <div className="card-header">📊 All Evaluation Runs</div>
            <div className="card-content">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Status</th>
                    <th>Model</th>
                    <th>Provider</th>
                    <th>Evals</th>
                    <th>Pass Rate</th>
                    <th>Duration</th>
                    <th>Date</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((run) => (
                    <RunRow key={run._id} run={run} />
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

function RunRow({ run }: { run: Run }) {
  const statusIcon = getRunStatusIcon(run.status);
  const passRate = run.evalCounts
    ? run.evalCounts.total > 0
      ? run.evalCounts.passed / run.evalCounts.total
      : 0
    : 0;
  const percentage = (passRate * 100).toFixed(1);
  const date = new Date(run._creationTime).toLocaleString();

  const duration =
    run.status.kind === "completed" || run.status.kind === "failed"
      ? formatDuration(run.status.durationMs)
      : "—";

  return (
    <tr className="cursor-pointer hover:bg-slate-800/50">
      <td>
        <Link
          to="/run/$runId"
          params={{ runId: run._id }}
          className="flex items-center gap-2 text-white hover:text-cyan-400"
        >
          <span>{statusIcon}</span>
        </Link>
      </td>
      <td>
        <Link
          to="/run/$runId"
          params={{ runId: run._id }}
          className="text-white hover:text-cyan-400 font-medium"
        >
          {run.model}
        </Link>
      </td>
      <td className="text-slate-400">{run.provider || "—"}</td>
      <td className="text-slate-300">
        {run.evalCounts ? (
          <span>
            <span className="text-green-400">{run.evalCounts.passed}</span>
            {" / "}
            <span>{run.evalCounts.total}</span>
            {run.evalCounts.failed > 0 && (
              <span className="text-red-400 ml-1">
                ({run.evalCounts.failed} failed)
              </span>
            )}
          </span>
        ) : (
          "—"
        )}
      </td>
      <td>
        <div className="score-bar-container w-24">
          <div className="score-bar" style={{ width: `${percentage}%` }} />
          <span className="score-text">{percentage}%</span>
        </div>
      </td>
      <td className="text-slate-400">{duration}</td>
      <td className="text-slate-500 text-sm">{date}</td>
    </tr>
  );
}

function Sidebar({
  runs,
  selectedRunId,
}: {
  runs: Run[];
  selectedRunId: string | null;
}) {
  // Group runs by model
  const modelCounts = new Map<string, number>();
  for (const run of runs) {
    modelCounts.set(run.model, (modelCounts.get(run.model) || 0) + 1);
  }
  const models = Array.from(modelCounts.keys()).sort();

  return (
    <aside className="w-72 bg-slate-800/50 border-r border-slate-700 overflow-auto">
      <div className="p-4 border-b border-slate-700">
        <h2 className="font-semibold text-white">Navigation</h2>
      </div>
      <nav className="p-2">
        <Link to="/" className="sidebar-item block mb-1 active">
          📊 All Runs
        </Link>
      </nav>
      <div className="p-4 border-t border-slate-700">
        <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">
          Recent Runs ({runs.length})
        </h3>
      </div>
      <nav className="p-2 pt-0">
        {runs.slice(0, 20).map((run) => {
          const passRate = run.evalCounts
            ? run.evalCounts.total > 0
              ? run.evalCounts.passed / run.evalCounts.total
              : 0
            : 0;
          const percentage = (passRate * 100).toFixed(1);
          const isActive = selectedRunId === run._id;
          const scoreStatus = getScoreStatus(passRate);
          const statusIcon = getRunStatusIcon(run.status);

          return (
            <Link
              key={run._id}
              to="/run/$runId"
              params={{ runId: run._id }}
              className={`sidebar-item block mb-1 ${isActive ? "active" : ""}`}
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-white truncate flex items-center gap-1">
                  <span>{statusIcon}</span>
                  {run.model}
                </span>
                <span
                  className={`text-xs font-bold ${
                    scoreStatus === "excellent"
                      ? "text-green-400"
                      : scoreStatus === "good"
                        ? "text-yellow-400"
                        : scoreStatus === "fair"
                          ? "text-orange-400"
                          : "text-red-400"
                  }`}
                >
                  {percentage}%
                </span>
              </div>
              <div className="text-xs text-slate-500 mt-1">
                {run.evalCounts
                  ? `${run.evalCounts.passed}/${run.evalCounts.total} passed`
                  : "No evals"}
              </div>
            </Link>
          );
        })}
      </nav>
      <div className="p-4 border-t border-slate-700">
        <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">
          Models ({models.length})
        </h3>
        <div className="space-y-1">
          {models.map((model) => {
            const count = modelCounts.get(model) || 0;
            return (
              <div
                key={model}
                className="flex items-center justify-between text-sm px-2 py-1"
              >
                <span className="text-slate-300 truncate">{model}</span>
                <span className="text-xs text-slate-500">{count}</span>
              </div>
            );
          })}
        </div>
      </div>
    </aside>
  );
}

export { Sidebar };
