import {
  createFileRoute,
  Link,
  Outlet,
  useParams,
} from "@tanstack/react-router";
import { getResults } from "../lib/data";
import { getScoreIcon, getScoreStatus, getPassFailIcon } from "../lib/types";
import type { EvalResult, CategorySummary } from "../lib/types";

export const Route = createFileRoute("/run/$runIndex")({
  loader: () => getResults(),
  component: RunLayout,
});

function RunLayout() {
  const results = Route.useLoaderData();
  const { runIndex } = useParams({ from: "/run/$runIndex" });
  const runIdx = parseInt(runIndex, 10);

  if (runIdx < 0 || runIdx >= results.length) {
    return <div className="p-8 text-red-400">Run not found</div>;
  }

  const result = results[runIdx];

  return (
    <div className="flex h-screen">
      <RunSidebar results={results} selectedRunIndex={runIdx} />
      <Outlet />
    </div>
  );
}

function RunSidebar({
  results,
  selectedRunIndex,
}: {
  results: EvalResult[];
  selectedRunIndex: number;
}) {
  const result = results[selectedRunIndex];
  const categories = result?.category_summaries ?? {};

  return (
    <aside className="w-72 bg-slate-800/50 border-r border-slate-700 overflow-auto flex flex-col">
      <div className="p-4 border-b border-slate-700">
        <Link to="/" className="text-cyan-400 hover:text-cyan-300 text-sm">
          ← All Runs
        </Link>
        <h2 className="font-semibold text-white mt-2">
          {result?.model_name ?? "Unknown Model"}
        </h2>
      </div>

      <div className="p-2 flex-1 overflow-auto">
        <div className="text-xs text-slate-500 uppercase tracking-wider px-3 py-2">
          Categories
        </div>
        {Object.entries(categories).map(([categoryName, stats]) => (
          <CategoryItem
            key={categoryName}
            categoryName={categoryName}
            stats={stats}
            runIndex={selectedRunIndex}
          />
        ))}
      </div>
    </aside>
  );
}

function CategoryItem({
  categoryName,
  stats,
  runIndex,
}: {
  categoryName: string;
  stats: CategorySummary;
  runIndex: number;
}) {
  const successRate = stats.total > 0 ? stats.passed / stats.total : 0;
  const icon =
    stats.passed === stats.total
      ? "✅"
      : stats.failed === stats.total
        ? "❌"
        : "⚠️";

  return (
    <Link
      to="/run/$runIndex/$category"
      params={{ runIndex: String(runIndex), category: categoryName }}
      className="sidebar-item block mb-1"
      activeProps={{ className: "sidebar-item active block mb-1" }}
    >
      <div className="flex items-center gap-2">
        <span>{icon}</span>
        <span className="text-sm text-slate-300 truncate flex-1">
          {categoryName}
        </span>
        <span className="text-xs text-slate-500">
          {stats.passed}/{stats.total}
        </span>
      </div>
    </Link>
  );
}
