import {
  createFileRoute,
  Link,
  Outlet,
  useParams,
} from "@tanstack/react-router";
import { useQuery } from "convex/react";
import { api } from "../../../evalScores/convex/_generated/api";
import type { Id } from "../../../evalScores/convex/_generated/dataModel";
import { getEvalStatusIcon, formatDuration, type Eval } from "../lib/types";

export const Route = createFileRoute("/run/$runId/$category")({
  component: CategoryLayout,
});

function CategoryLayout() {
  const { runId, category } = useParams({ from: "/run/$runId/$category" });
  const run = useQuery(api.runs.getRunDetails, {
    runId: runId as Id<"runs">,
  });

  if (run === undefined) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="text-slate-400">Loading...</div>
      </div>
    );
  }

  if (run === null) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="text-red-400">Run not found</div>
      </div>
    );
  }

  const categoryEvals = run.evals.filter((e) => e.category === category);

  return (
    <div className="flex flex-1 overflow-hidden">
      <EvalsSidebar
        evals={categoryEvals}
        runId={runId}
        category={category}
      />
      <Outlet />
    </div>
  );
}

function EvalsSidebar({
  evals,
  runId,
  category,
}: {
  evals: Eval[];
  runId: string;
  category: string;
}) {
  // Sort evals by name
  const sortedEvals = [...evals].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <aside className="w-64 bg-slate-800/30 border-r border-slate-700 overflow-auto">
      <div className="p-3 border-b border-slate-700">
        <div className="text-xs text-slate-500 uppercase tracking-wider">
          Evaluations ({evals.length})
        </div>
      </div>
      <nav className="p-2">
        {sortedEvals.map((evalItem) => {
          const statusIcon = getEvalStatusIcon(evalItem.status);
          const duration =
            evalItem.status.kind === "passed" || evalItem.status.kind === "failed"
              ? formatDuration(evalItem.status.durationMs)
              : null;

          return (
            <Link
              key={evalItem._id}
              to="/run/$runId/$category/$evalId"
              params={{
                runId,
                category,
                evalId: evalItem._id,
              }}
              search={{ tab: "steps" }}
              className="sidebar-item block mb-1"
              activeProps={{ className: "sidebar-item active block mb-1" }}
            >
              <div className="flex items-center gap-2">
                <span>{statusIcon}</span>
                <span className="text-sm text-slate-300 truncate flex-1">
                  {evalItem.name}
                </span>
              </div>
              {evalItem.status.kind === "failed" && (
                <div className="mt-1 text-xs text-red-400 truncate">
                  {evalItem.status.failureReason}
                </div>
              )}
              {duration && (
                <div className="mt-1 text-xs text-slate-500">{duration}</div>
              )}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
