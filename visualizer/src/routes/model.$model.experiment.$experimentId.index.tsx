import { createFileRoute, useParams, useNavigate } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import { api } from "../convex/api";
import { getRunStatusIcon, formatDuration, type Run } from "../lib/types";
import { shortRunId } from "../lib/breadcrumbs";
import { useResolvedModelId } from "../lib/useResolvedModelId";

export const Route = createFileRoute("/model/$model/experiment/$experimentId/")({
  component: ModelExperimentRunsPage,
});

function ModelExperimentRunsPage() {
  const { model, experimentId } = useParams({
    from: "/model/$model/experiment/$experimentId/",
  });

  const modelId = useResolvedModelId(model);
  const runs = useQuery(api.runs.listRuns, modelId ? { modelId } : "skip");

  if (modelId === null) {
    return (
      <main className="flex-1 overflow-auto p-6">
        <div className="text-slate-400">Model not found.</div>
      </main>
    );
  }

  if (modelId === undefined || runs === undefined) {
    return (
      <main className="flex-1 overflow-auto p-6">
        <div className="text-slate-400">Loading runs...</div>
      </main>
    );
  }

  // Filter runs for this experiment
  const filteredRuns =
    experimentId === "default"
      ? runs.filter((r) => !r.experiment)
      : runs.filter((r) => r.experiment === experimentId);

  const displayName = experimentId === "default" ? "with_guidelines" : experimentId;

  const modelDisplayName = filteredRuns[0]?.formattedName ?? model;

  return (
    <main className="flex-1 overflow-auto p-6">
      <div className="max-w-6xl mx-auto">
        <header className="mb-8">
          <h1 className="text-3xl font-bold text-white mb-2">
            {modelDisplayName} / {displayName}
          </h1>
          <p className="text-slate-400">Select a run to view detailed results</p>
        </header>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
          <div className="stat-card">
            <div className="stat-number">{filteredRuns.length}</div>
            <div className="stat-label">Total Runs</div>
          </div>
          <div className="stat-card">
            <div className="stat-number">
              {filteredRuns.filter((r) => r.status.kind === "completed").length}
            </div>
            <div className="stat-label">Completed</div>
          </div>
          <div className="stat-card">
            <div className="stat-number">
              {filteredRuns.filter(
                (r) => r.status.kind === "running" || r.status.kind === "pending"
              ).length}
            </div>
            <div className="stat-label">In Progress</div>
          </div>
          <div className="stat-card">
            <div className="stat-number">
              {filteredRuns.filter((r) => r.status.kind === "failed").length}
            </div>
            <div className="stat-label">Failed</div>
          </div>
        </div>

        <div className="card">
          <div className="card-header">📊 Evaluation Runs</div>
          <div className="card-content">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Run ID</th>
                  <th>Provider</th>
                  <th>Evals</th>
                  <th>Pass Rate</th>
                  <th>Duration</th>
                  <th>Date</th>
                </tr>
              </thead>
              <tbody>
                {filteredRuns.map((run) => (
                  <RunRow
                    key={run._id}
                    model={model}
                    experimentId={experimentId}
                    run={run}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </main>
  );
}

function RunRow({
  model,
  experimentId,
  run,
}: {
  model: string;
  experimentId: string;
  run: Run;
}) {
  const navigate = useNavigate();
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
    <tr
      className="cursor-pointer hover:bg-slate-800/50"
      onClick={() =>
        navigate({
          to: "/model/$model/experiment/$experimentId/run/$runId",
          params: { model, experimentId, runId: run._id },
        })
      }
    >
      <td>
        <span className="flex items-center gap-2">{statusIcon}</span>
      </td>
      <td className="text-slate-400 font-mono text-sm" title={run._id}>
        {shortRunId(run._id)}
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
