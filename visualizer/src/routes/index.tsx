import { createFileRoute, Link } from "@tanstack/react-router";
import { getResults } from "../lib/data";
import { getScoreIcon, getScoreStatus } from "../lib/types";
import type { EvalResult } from "../lib/types";

export const Route = createFileRoute("/")({
  loader: () => getResults(),
  component: RunsListPage,
});

function RunsListPage() {
  const results = Route.useLoaderData();

  return (
    <div className="flex h-screen">
      <Sidebar results={results} selectedRunIndex={-1} />
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

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
            <div className="stat-card">
              <div className="stat-number">{results.length}</div>
              <div className="stat-label">Total Runs</div>
            </div>
          </div>

          <div className="card">
            <div className="card-header">📊 All Evaluation Runs</div>
            <div className="card-content">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Model</th>
                    <th>Overall Score</th>
                    <th>Pass/Total</th>
                    <th>Temp Directory</th>
                  </tr>
                </thead>
                <tbody>
                  {results.map((result, index) => (
                    <RunRow key={index} result={result} index={index} />
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

function RunRow({ result, index }: { result: EvalResult; index: number }) {
  const modelName = result.model_name ?? "Unknown Model";
  const overallScore = result.run_stats?.overall_score ?? 0;
  const percentage = (overallScore * 100).toFixed(1);
  const totalTests = result.run_stats?.total_tests ?? 0;
  const passedTests = result.run_stats?.total_passed ?? 0;
  const statusIcon = getScoreIcon(overallScore);

  return (
    <tr className="cursor-pointer">
      <td>
        <Link
          to="/run/$runIndex"
          params={{ runIndex: String(index) }}
          className="flex items-center gap-2 text-white hover:text-cyan-400"
        >
          <span>{statusIcon}</span>
          <strong>{modelName}</strong>
        </Link>
      </td>
      <td>
        <div className="score-bar-container w-32">
          <div className="score-bar" style={{ width: `${percentage}%` }} />
          <span className="score-text">{percentage}%</span>
        </div>
      </td>
      <td className="text-slate-300">
        {passedTests}/{totalTests}
      </td>
      <td>
        <code className="text-xs text-slate-500">
          {result.tempdir ?? "N/A"}
        </code>
      </td>
    </tr>
  );
}

function Sidebar({
  results,
  selectedRunIndex,
}: {
  results: EvalResult[];
  selectedRunIndex: number;
}) {
  return (
    <aside className="w-72 bg-slate-800/50 border-r border-slate-700 overflow-auto">
      <div className="p-4 border-b border-slate-700">
        <h2 className="font-semibold text-white">Evaluation Runs</h2>
      </div>
      <nav className="p-2">
        {results.map((result, index) => {
          const modelName = result.model_name ?? "Unknown Model";
          const overallScore = result.run_stats?.overall_score ?? 0;
          const percentage = (overallScore * 100).toFixed(1);
          const totalPassed = result.run_stats?.total_passed ?? 0;
          const totalTests = result.run_stats?.total_tests ?? 0;
          const isActive = selectedRunIndex === index;
          const scoreStatus = getScoreStatus(overallScore);

          return (
            <Link
              key={index}
              to="/run/$runIndex"
              params={{ runIndex: String(index) }}
              className={`sidebar-item block mb-1 ${isActive ? "active" : ""}`}
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-white truncate">
                  {modelName}
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
                {totalPassed}/{totalTests} passed
              </div>
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}

export { Sidebar };
