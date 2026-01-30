import {
  createFileRoute,
  Link,
  Outlet,
  useParams,
} from "@tanstack/react-router";
import { useQuery } from "convex/react";
import { api } from "../../../evalScores/convex/_generated/api";
import type { Id } from "../../../evalScores/convex/_generated/dataModel";
import {
  getRunStatusIcon,
  formatDuration,
  type Run,
  type Eval,
} from "../lib/types";

export const Route = createFileRoute("/run/$runId")({
  component: RunLayout,
});

function RunLayout() {
  const { runId } = useParams({ from: "/run/$runId" });
  const run = useQuery(api.runs.getRunDetails, {
    runId: runId as Id<"runs">,
  });

  if (run === undefined) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="text-slate-400">Loading run...</div>
      </div>
    );
  }

  if (run === null) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="text-red-400">Run not found</div>
      </div>
    );
  }

  return (
    <div className="flex h-screen">
      <RunSidebar run={run} />
      <Outlet />
    </div>
  );
}

function RunSidebar({ run }: { run: Run & { evals: Eval[] } }) {
  // Group evals by category
  const evalsByCategory = new Map<string, Eval[]>();
  for (const evalItem of run.evals) {
    const category = evalItem.category;
    if (!evalsByCategory.has(category)) {
      evalsByCategory.set(category, []);
    }
    evalsByCategory.get(category)!.push(evalItem);
  }

  const categories = Array.from(evalsByCategory.keys()).sort();

  return (
    <aside className="w-72 bg-slate-800/50 border-r border-slate-700 overflow-auto flex flex-col">
      <div className="p-4 border-b border-slate-700">
        <Link to="/" className="text-cyan-400 hover:text-cyan-300 text-sm">
          ← All Runs
        </Link>
        <div className="flex items-center gap-2 mt-2">
          <span>{getRunStatusIcon(run.status)}</span>
          <h2 className="font-semibold text-white">{run.model}</h2>
        </div>
        {run.provider && (
          <div className="text-xs text-slate-500 mt-1">{run.provider}</div>
        )}
        {(run.status.kind === "completed" || run.status.kind === "failed") && (
          <div className="text-xs text-slate-500 mt-1">
            Duration: {formatDuration(run.status.durationMs)}
          </div>
        )}
      </div>

      <div className="p-2 flex-1 overflow-auto">
        <div className="text-xs text-slate-500 uppercase tracking-wider px-3 py-2">
          Categories ({categories.length})
        </div>
        {categories.map((category) => {
          const evals = evalsByCategory.get(category)!;
          const passed = evals.filter((e) => e.status.kind === "passed").length;
          const total = evals.length;
          const icon =
            passed === total ? "✅" : passed === 0 ? "❌" : "⚠️";

          return (
            <Link
              key={category}
              to="/run/$runId/$category"
              params={{ runId: run._id, category }}
              className="sidebar-item block mb-1"
              activeProps={{ className: "sidebar-item active block mb-1" }}
            >
              <div className="flex items-center gap-2">
                <span>{icon}</span>
                <span className="text-sm text-slate-300 truncate flex-1">
                  {formatCategoryName(category)}
                </span>
                <span className="text-xs text-slate-500">
                  {passed}/{total}
                </span>
              </div>
            </Link>
          );
        })}
      </div>
    </aside>
  );
}

function formatCategoryName(category: string): string {
  return category
    .replace(/^\d+-/, "")
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
