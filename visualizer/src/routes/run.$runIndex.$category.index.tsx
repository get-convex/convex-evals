import { createFileRoute, useParams, Link } from "@tanstack/react-router";
import { getResults } from "../lib/data";
import { getPassFailIcon } from "../lib/types";

export const Route = createFileRoute("/run/$runIndex/$category/")({
  loader: () => getResults(),
  component: CategoryOverviewPage,
});

function CategoryOverviewPage() {
  const results = Route.useLoaderData();
  const { runIndex, category } = useParams({
    from: "/run/$runIndex/$category/",
  });
  const runIdx = parseInt(runIndex, 10);
  const result = results[runIdx];

  if (!result) {
    return <div className="p-8 text-red-400">Run not found</div>;
  }

  const categoryResults = (result.individual_results ?? []).filter(
    (r) => r.category === category,
  );
  const categoryStats = result.category_summaries?.[category];
  const successRate = categoryStats
    ? ((categoryStats.passed / categoryStats.total) * 100).toFixed(1)
    : "0.0";

  return (
    <main className="flex-1 overflow-auto p-6">
      <div className="max-w-4xl mx-auto">
        <header className="mb-8">
          <div className="breadcrumb">
            <Link to="/" className="breadcrumb-btn">
              All Runs
            </Link>
            <span className="breadcrumb-separator">→</span>
            <Link
              to="/run/$runIndex"
              params={{ runIndex }}
              className="breadcrumb-btn"
            >
              {result.model_name ?? "Unknown Model"}
            </Link>
            <span className="breadcrumb-separator">→</span>
            <span className="breadcrumb-current">{category}</span>
          </div>
          <h1 className="text-2xl font-bold text-white">{category}</h1>
        </header>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
          <div className="stat-card overall-score">
            <div className="stat-number">{successRate}%</div>
            <div className="stat-label">Success Rate</div>
          </div>
          <div className="stat-card pass-rate">
            <div className="stat-number">{categoryStats?.passed ?? 0}</div>
            <div className="stat-label">Passed</div>
          </div>
          <div className="stat-card total-tests">
            <div className="stat-number">{categoryStats?.failed ?? 0}</div>
            <div className="stat-label">Failed</div>
          </div>
        </div>

        <div className="card">
          <div className="card-header">🔍 Individual Results - {category}</div>
          <div className="card-content">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Evaluation</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {categoryResults.map((evalResult) => {
                  const statusIcon = getPassFailIcon(evalResult.passed);
                  return (
                    <tr
                      key={evalResult.name}
                      className={evalResult.passed ? "pass" : "fail"}
                    >
                      <td>
                        <Link
                          to="/run/$runIndex/$category/$evalName"
                          params={{
                            runIndex,
                            category,
                            evalName: evalResult.name,
                          }}
                          className="flex items-center gap-2 hover:text-cyan-400"
                        >
                          <span>{statusIcon}</span>
                          {evalResult.name}
                        </Link>
                      </td>
                      <td className="text-slate-400">
                        {evalResult.passed
                          ? "Pass"
                          : (evalResult.failure_reason ?? "Failed")}
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
