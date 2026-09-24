import { createFileRoute, Link } from "@tanstack/react-router";
import { usePaginatedQuery, useQuery } from "convex/react";
import { decisions } from "../convex/decisions";
import { cost } from "../lib/decisions/data";

export const Route = createFileRoute("/decision/")({
  validateSearch: (
    search: Record<string, unknown>,
  ): { benchmark?: string } => ({
    benchmark:
      typeof search.benchmark === "string" ? search.benchmark : undefined,
  }),
  component: DecisionRunsPage,
});
function DecisionRunsPage() {
  const versions = useQuery(decisions.versions, {});
  const { benchmark } = Route.useSearch();
  const navigate = Route.useNavigate();
  const selected =
    benchmark ?? versions?.find((version) => version.isCurrent)?.version;
  const valid = versions?.some((version) => version.version === selected);
  return (
    <main className="min-w-0 flex-1 overflow-auto p-6">
      <div className="mx-auto max-w-6xl">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
          <h1 className="text-2xl font-semibold">Decision runs</h1>
          <label className="flex items-center gap-2 text-sm text-slate-400">
            Benchmark
            <select
              value={valid ? selected : ""}
              disabled={!versions?.length}
              onChange={(event) =>
                navigate({ search: { benchmark: event.target.value } })
              }
              className="rounded border border-slate-600 bg-slate-900 px-3 py-2 text-slate-100"
            >
              {!valid && (
                <option value="">
                  {!versions
                    ? "Loading…"
                    : versions.length === 0
                      ? "No decision benchmarks"
                      : "Choose a benchmark"}
                </option>
              )}
              {versions?.map((version) => (
                <option key={version.version} value={version.version}>
                  {new Date(version.effectiveAt).toLocaleDateString("en-GB", {
                    timeZone: "UTC",
                    day: "numeric",
                    month: "short",
                    year: "numeric",
                  })}
                  {version.isCurrent ? " (current)" : ""}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="mb-6 text-slate-400">
          Browse model runs, then explore tasks, questions, and recorded
          answers.
        </p>
        {selected && valid ? (
          <RunList key={selected} benchmark={selected} />
        ) : (
          versions && <p>Select an available decision benchmark.</p>
        )}
      </div>
    </main>
  );
}
function RunList({ benchmark }: { benchmark: string }) {
  const runs = usePaginatedQuery(
    decisions.runs,
    { benchmarkVersion: benchmark, condition: "no_guidelines" },
    { initialNumItems: 30 },
  );
  return (
    <>
      <div className="overflow-x-auto">
        <table className="data-table">
          <thead>
            <tr>
              <th>Model</th>
              <th>Score</th>
              <th>Correct / planned</th>
              <th>Cost</th>
              <th>Started</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {runs.results.map((run) => (
              <tr key={run._id}>
                <td>
                  <Link
                    to="/decision/run/$runId"
                    params={{ runId: run._id }}
                    search={{}}
                    className="font-medium text-cyan-400 underline"
                  >
                    {run.formattedName}
                  </Link>
                </td>
                <td>
                  {run.summary
                    ? `${(run.summary.score * 100).toFixed(1)}%`
                    : "Pending"}
                </td>
                <td>
                  {run.summary?.correctQuestions ?? "–"} /{" "}
                  {run.plannedQuestionCount}
                </td>
                <td>
                  {run.summary?.estimatedCostUsd !== undefined
                    ? `~${cost(run.summary.estimatedCostUsd)}`
                    : cost(run.summary?.costUsd)}
                </td>
                <td className="whitespace-nowrap">
                  {new Date(run._creationTime).toLocaleString()}
                </td>
                <td>
                  {run.status}
                  {!run.leaderboardEligible && (
                    <span className="block text-xs text-slate-400">
                      Excluded from rankings
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {runs.status === "LoadingFirstPage" && (
        <p className="py-4 text-slate-400">Loading runs…</p>
      )}
      {runs.status === "Exhausted" && runs.results.length === 0 && (
        <p className="py-4 text-slate-400">
          No decision runs for this benchmark and condition.
        </p>
      )}
      {runs.status !== "Exhausted" && runs.status !== "LoadingFirstPage" && (
        <button
          disabled={runs.status === "LoadingMore"}
          onClick={() => runs.loadMore(30)}
          className="mt-4 rounded border border-slate-600 px-4 py-2"
        >
          {runs.status === "LoadingMore" ? "Loading…" : "Load more runs"}
        </button>
      )}
    </>
  );
}
