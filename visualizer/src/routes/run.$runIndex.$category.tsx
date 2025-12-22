import {
  createFileRoute,
  Link,
  Outlet,
  useParams,
} from "@tanstack/react-router";
import { getResults } from "../lib/data";
import { parseFailureReasons, getPassFailIcon } from "../lib/types";
import type { EvalResult, IndividualResult } from "../lib/types";

export const Route = createFileRoute("/run/$runIndex/$category")({
  loader: () => getResults(),
  component: CategoryLayout,
});

function CategoryLayout() {
  const results = Route.useLoaderData();
  const { runIndex, category } = useParams({
    from: "/run/$runIndex/$category",
  });
  const runIdx = parseInt(runIndex, 10);
  const result = results[runIdx];

  if (!result) {
    return <div className="p-8 text-red-400">Run not found</div>;
  }

  const categoryResults = (result.individual_results ?? []).filter(
    (r) => r.category === category,
  );

  return (
    <div className="flex flex-1 overflow-hidden">
      <EvalsSidebar
        categoryResults={categoryResults}
        runIndex={runIdx}
        category={category}
      />
      <Outlet />
    </div>
  );
}

function EvalsSidebar({
  categoryResults,
  runIndex,
  category,
}: {
  categoryResults: IndividualResult[];
  runIndex: number;
  category: string;
}) {
  return (
    <aside className="w-64 bg-slate-800/30 border-r border-slate-700 overflow-auto">
      <div className="p-3 border-b border-slate-700">
        <div className="text-xs text-slate-500 uppercase tracking-wider">
          Evaluations
        </div>
      </div>
      <nav className="p-2">
        {categoryResults.map((evalResult) => {
          const failureReasons = parseFailureReasons(evalResult);
          const statusIcon = getPassFailIcon(evalResult.passed);

          return (
            <Link
              key={evalResult.name}
              to="/run/$runIndex/$category/$evalName"
              params={{
                runIndex: String(runIndex),
                category,
                evalName: evalResult.name,
              }}
              className="sidebar-item block mb-1"
              activeProps={{ className: "sidebar-item active block mb-1" }}
            >
              <div className="flex items-center gap-2">
                <span>{statusIcon}</span>
                <span className="text-sm text-slate-300 truncate flex-1">
                  {evalResult.name}
                </span>
              </div>
              {!evalResult.passed && failureReasons.length > 0 ? (
                <div className="mt-1 flex flex-wrap">
                  {failureReasons.map((reason) => (
                    <span key={reason} className="failure-reason">
                      {reason}
                    </span>
                  ))}
                </div>
              ) : null}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
