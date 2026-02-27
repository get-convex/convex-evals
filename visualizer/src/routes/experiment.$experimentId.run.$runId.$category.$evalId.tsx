import {
  createFileRoute,
  useParams,
  Link,
  useSearch,
} from "@tanstack/react-router";
import { useQuery } from "convex/react";
import { api } from "../convex/api";
import type { Id } from "../convex/types";
import { getEvalStatusIcon, formatDuration } from "../lib/types";
import { StepsTab, OutputTab, TaskTab } from "../lib/evalComponents";

export const Route = createFileRoute("/experiment/$experimentId/run/$runId/$category/$evalId")({
  validateSearch: (search: Record<string, unknown>): { tab: string; file?: string } => ({
    tab: (search.tab as string) ?? "steps",
    file: (search.file as string) ?? undefined,
  }),
  component: EvalDetailsPage,
});

function EvalDetailsPage() {
  const { experimentId, runId, category, evalId } = useParams({
    from: "/experiment/$experimentId/run/$runId/$category/$evalId",
  });
  const { tab, file } = useSearch({ from: "/experiment/$experimentId/run/$runId/$category/$evalId" });

  const run = useQuery(api.runs.getRunDetails, {
    runId: runId as Id<"runs">,
  });

  if (run === undefined) {
    return (
      <main className="flex-1 flex items-center justify-center">
        <div className="text-slate-400">Loading...</div>
      </main>
    );
  }

  if (run === null) {
    return (
      <main className="flex-1 flex items-center justify-center">
        <div className="text-red-400">Run not found</div>
      </main>
    );
  }

  const evalItem = run.evals.find((e) => e._id === evalId);

  if (!evalItem) {
    return (
      <main className="flex-1 flex items-center justify-center">
        <div className="text-red-400">Evaluation not found</div>
      </main>
    );
  }

  return (
    <main className="flex-1 flex flex-col overflow-hidden">
      <div className="border-b border-slate-700 px-6 py-4">
        <div className="flex items-center gap-3">
          <span className="text-2xl">{getEvalStatusIcon(evalItem.status)}</span>
          <h1 className="text-xl font-bold text-white">{evalItem.name}</h1>
          {(evalItem.status.kind === "passed" || evalItem.status.kind === "failed") && (
            <span className="text-slate-500 text-sm">
              {formatDuration(evalItem.status.durationMs)}
            </span>
          )}
        </div>
        {evalItem.status.kind === "failed" && (
          <div className="mt-2 text-red-400 text-sm">
            {evalItem.status.failureReason}
          </div>
        )}
      </div>

      <div className="tab-nav px-6">
        <TabButton
          tab="steps"
          currentTab={tab}
          experimentId={experimentId}
          runId={runId}
          category={category}
          evalId={evalId}
        >
          📊 Steps
        </TabButton>
        <TabButton
          tab="output"
          currentTab={tab}
          experimentId={experimentId}
          runId={runId}
          category={category}
          evalId={evalId}
        >
          📦 Output
        </TabButton>
        <TabButton
          tab="task"
          currentTab={tab}
          experimentId={experimentId}
          runId={runId}
          category={category}
          evalId={evalId}
        >
          📋 Task
        </TabButton>
      </div>

      <div className="flex-1 overflow-hidden">
        {tab === "steps" ? (
          <StepsTab
            steps={evalItem.steps || []}
            evalStatus={evalItem.status}
            routePath="/experiment/$experimentId/run/$runId/$category/$evalId"
            experimentId={experimentId}
            runId={runId}
            category={category}
            evalId={evalId}
          />
        ) : tab === "output" ? (
          <OutputTab
            evalStatus={evalItem.status}
            routePath="/experiment/$experimentId/run/$runId/$category/$evalId"
            experimentId={experimentId}
            runId={runId}
            category={category}
            evalId={evalId}
            initialFile={file}
          />
        ) : tab === "task" ? (
          <TaskTab
            evalSourceStorageId={evalItem.evalSourceStorageId}
            routePath="/experiment/$experimentId/run/$runId/$category/$evalId"
            experimentId={experimentId}
            runId={runId}
            category={category}
            evalId={evalId}
            initialFile={file}
          />
        ) : null}
      </div>
    </main>
  );
}

function TabButton({
  tab,
  currentTab,
  experimentId,
  runId,
  category,
  evalId,
  children,
}: {
  tab: string;
  currentTab: string;
  experimentId: string;
  runId: string;
  category: string;
  evalId: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      to="/experiment/$experimentId/run/$runId/$category/$evalId"
      params={{ experimentId, runId, category, evalId }}
      search={{ tab }}
      className={`tab-button ${currentTab === tab ? "active" : ""}`}
    >
      {children}
    </Link>
  );
}
