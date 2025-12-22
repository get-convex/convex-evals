import { createFileRoute, useParams } from "@tanstack/react-router";
import { getResults } from "../lib/data";

export const Route = createFileRoute("/run/$runIndex/")({
  loader: () => getResults(),
  component: RunOverviewPage,
});

function RunOverviewPage() {
  const results = Route.useLoaderData();
  const { runIndex } = useParams({ from: "/run/$runIndex/" });
  const runIdx = parseInt(runIndex, 10);
  const result = results[runIdx];

  if (!result) {
    return <div className="p-8 text-red-400">Run not found</div>;
  }

  const modelName = result.model_name ?? "Unknown Model";
  const overallScore = result.run_stats?.overall_score ?? 0;
  const totalPassed = result.run_stats?.total_passed ?? 0;
  const totalFailed = result.run_stats?.total_failed ?? 0;

  return (
    <main className="flex-1 overflow-auto p-6">
      <div className="max-w-6xl mx-auto">
        <header className="mb-8">
          <h1 className="text-3xl font-bold text-white mb-2">{modelName}</h1>
          <p className="text-slate-400">
            Select a category from the sidebar to view individual evaluations
          </p>
        </header>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
          <div className="stat-card overall-score">
            <div className="stat-number">
              {(overallScore * 100).toFixed(1)}%
            </div>
            <div className="stat-label">Overall Score</div>
          </div>
          <div className="stat-card pass-rate">
            <div className="stat-number">{totalPassed}</div>
            <div className="stat-label">Tests Passed</div>
          </div>
          <div className="stat-card total-tests">
            <div className="stat-number">{totalFailed}</div>
            <div className="stat-label">Tests Failed</div>
          </div>
        </div>

        <div className="card">
          <div className="card-header">📋 Category Breakdown</div>
          <div className="card-content">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Category</th>
                  <th>Success Rate</th>
                  <th>Passed</th>
                  <th>Failed</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(result.category_summaries ?? {}).map(
                  ([category, stats]) => {
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
                      <tr
                        key={category}
                        className={
                          stats.passed === stats.total
                            ? "pass"
                            : stats.failed === stats.total
                              ? "fail"
                              : ""
                        }
                      >
                        <td>
                          <span className="mr-2">{icon}</span>
                          {category}
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
                      </tr>
                    );
                  },
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </main>
  );
}
