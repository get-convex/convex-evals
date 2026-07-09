import { Link, useRouterState } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import { useState } from "react";
import { api } from "../convex/api";
import type { Id } from "../convex/types";
import {
  getScoreStatus,
  getRunStatusIcon,
  getEvalStatusIcon,
  type Run,
  type Eval,
} from "./types";
import { formatCategoryName } from "./evalComponents";
import { formatRunLabel } from "./breadcrumbs";
import { useResolvedModelId } from "./useResolvedModelId";

type SidebarLevel = 
  | "home" 
  | "experiment" 
  | "run" 
  | "category" 
  | "eval"
  | "model"
  | "modelExperiment"
  | "modelRun"
  | "modelCategory"
  | "modelEval";

const SIDEBAR_MODELS_PAGE_SIZE = 25;

function parsePath(pathname: string): {
  level: SidebarLevel;
  model?: string;
  experimentId?: string;
  runId?: string;
  category?: string;
  evalId?: string;
} {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0)
    return { level: "home" };

  // Handle model-based routes: /model/$model/...
  if (segments[0] === "model" && segments[1]) {
    const model = decodeURIComponent(segments[1]);
    
    if (segments[2] !== "experiment" || !segments[3])
      return { level: "model", model };
    
    const experimentId = segments[3];
    if (segments[4] !== "run" || !segments[5])
      return { level: "modelExperiment", model, experimentId };
    
    const runId = segments[5];
    if (!segments[6])
      return { level: "modelRun", model, experimentId, runId };
    
    const category = segments[6];
    if (!segments[7])
      return { level: "modelCategory", model, experimentId, runId, category };
    
    return {
      level: "modelEval",
      model,
      experimentId,
      runId,
      category,
      evalId: segments[7],
    };
  }

  // Handle experiment-based routes: /experiment/$experimentId/...
  if (segments[0] !== "experiment" || !segments[1])
    return { level: "home" };

  const experimentId = segments[1];
  if (segments[2] !== "run" || !segments[3])
    return { level: "experiment", experimentId };

  const runId = segments[3];
  if (!segments[4])
    return { level: "run", experimentId, runId };

  const category = segments[4];
  if (!segments[5])
    return { level: "category", experimentId, runId, category };

  return {
    level: "eval",
    experimentId,
    runId,
    category,
    evalId: segments[5],
  };
}

function experimentDisplayName(id: string): string {
  return id === "default" ? "with_guidelines" : id;
}

function formatRelativeTime(ms: number): string {
  const now = Date.now();
  const diffMs = now - ms;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);

  if (diffSec < 60) return "just now";
  if (diffMin < 60) return `${diffMin} min ago`;
  if (diffHr < 24) return `${diffHr} hr ago`;
  if (diffDay < 7) return `${diffDay} day${diffDay === 1 ? "" : "s"} ago`;
  return new Date(ms).toLocaleDateString();
}

function BackIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="m15 18-6-6 6-6" />
    </svg>
  );
}

export function AppSidebar() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { level, model, experimentId, runId, category, evalId } = parsePath(pathname);

  const asideClass =
    "w-72 bg-slate-800/50 border-r border-slate-700 overflow-auto flex flex-col shrink-0 sidebar-panel";

  if (level === "home") {
    return (
      <aside key={pathname} className={asideClass}>
        <SidebarHome />
      </aside>
    );
  }

  // Model-based navigation
  if (level === "model" && model) {
    return (
      <aside key={pathname} className={asideClass}>
        <SidebarModel model={model} />
      </aside>
    );
  }

  if (level === "modelExperiment" && model && experimentId) {
    return (
      <aside key={pathname} className={asideClass}>
        <SidebarModelExperiment model={model} experimentId={experimentId} />
      </aside>
    );
  }

  if (level === "modelRun" && model && experimentId && runId) {
    return (
      <aside key={pathname} className={asideClass}>
        <SidebarModelRun model={model} experimentId={experimentId} runId={runId} />
      </aside>
    );
  }

  if (level === "modelCategory" && model && experimentId && runId && category) {
    return (
      <aside key={pathname} className={asideClass}>
        <SidebarModelCategory
          model={model}
          experimentId={experimentId}
          runId={runId}
          category={category}
        />
      </aside>
    );
  }

  if (level === "modelEval" && model && experimentId && runId && category && evalId) {
    return (
      <aside key={pathname} className={asideClass}>
        <SidebarModelEvalDetail
          model={model}
          experimentId={experimentId}
          runId={runId}
          category={category}
          evalId={evalId}
        />
      </aside>
    );
  }

  // Experiment-based navigation
  if (level === "experiment" && experimentId) {
    return (
      <aside key={pathname} className={asideClass}>
        <SidebarExperiment experimentId={experimentId} />
      </aside>
    );
  }

  if (level === "run" && experimentId && runId) {
    return (
      <aside key={pathname} className={asideClass}>
        <SidebarRun experimentId={experimentId} runId={runId} />
      </aside>
    );
  }

  if (level === "category" && experimentId && runId && category) {
    return (
      <aside key={pathname} className={asideClass}>
        <SidebarCategory
          experimentId={experimentId}
          runId={runId}
          category={category}
        />
      </aside>
    );
  }

  if (level === "eval" && experimentId && runId && category && evalId) {
    return (
      <aside key={pathname} className={asideClass}>
        <SidebarEvalDetail
          experimentId={experimentId}
          runId={runId}
          category={category}
          evalId={evalId}
        />
      </aside>
    );
  }

  return (
    <aside key={pathname} className={asideClass}>
      <SidebarHome />
    </aside>
  );
}

function SidebarHome() {
  const [modelLimit, setModelLimit] = useState(SIDEBAR_MODELS_PAGE_SIZE);
  const experiments = useQuery(api.runs.listExperiments, {});
  const models = useQuery(api.models.listModels, {
    paginationOpts: { cursor: null, numItems: modelLimit },
  });

  if (experiments === undefined || models === undefined) {
    return (
      <div className="p-4 text-slate-400 text-sm">Loading...</div>
    );
  }

  return (
    <>
      <div className="sidebar-list-section">
        <p className="sidebar-list-label">By Experiment</p>
        <nav className="p-2 overflow-auto">
          {experiments.map((exp) => {
            const percentage = (exp.passRate * 100).toFixed(1);
            return (
              <Link
                key={exp.name}
                to="/experiment/$experimentId"
                params={{ experimentId: exp.name }}
                className="sidebar-item block mb-1"
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-white truncate">
                    {exp.name === "default" ? "with_guidelines" : exp.name}
                  </span>
                  <span className="text-xs font-bold text-cyan-400">
                    {percentage}%
                  </span>
                </div>
                <div className="text-xs text-slate-500 mt-1">
                  {exp.runCount} runs · {exp.modelCount} models
                </div>
              </Link>
            );
          })}
        </nav>
      </div>
      <div className="sidebar-list-section">
        <p className="sidebar-list-label">By Model</p>
        <nav className="p-2 flex-1 overflow-auto">
          {models.page.map((model) => (
            <SidebarModelLink key={model._id} modelId={model._id} name={model.formattedName} />
          ))}
          {!models.isDone && (
            <button
              className="mt-2 w-full rounded-md border border-slate-700 px-2 py-1 text-left text-xs text-slate-400 hover:bg-slate-800/50"
              onClick={() =>
                setModelLimit((current) => current + SIDEBAR_MODELS_PAGE_SIZE)
              }
            >
              Load more models
            </button>
          )}
        </nav>
      </div>
    </>
  );
}

function SidebarModelLink({
  modelId,
  name,
}: {
  modelId: Id<"models">;
  name: string;
}) {
  const summary = useQuery(api.runs.getModelSummary, { modelId });
  const percentage =
    summary === undefined ? "..." : (summary.passRate * 100).toFixed(1);

  return (
    <Link
      to="/model/$model"
      params={{ model: modelId }}
      className="sidebar-item block mb-1"
    >
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-white truncate">
          {name}
        </span>
        <span className="text-xs font-bold text-cyan-400">
          {summary === undefined ? "..." : `${percentage}%`}
        </span>
      </div>
      <div className="text-xs text-slate-500 mt-1">
        {summary === undefined
          ? "Loading summary..."
          : `${summary.runCount} runs · ${summary.experimentCount} experiments`}
      </div>
    </Link>
  );
}

function SidebarExperiment({ experimentId }: { experimentId: string }) {
  const runs = useQuery(api.runs.listRuns, {
    experiment: experimentId === "default" ? undefined : (experimentId as "no_guidelines"),
  });

  const filteredRuns =
    runs === undefined
      ? undefined
      : experimentId === "default"
        ? runs.filter((r) => !r.experiment)
        : runs;

  const displayName = experimentDisplayName(experimentId);

  return (
    <>
      <div className="sidebar-header">
        <div className="sidebar-header-title-row">
          <Link
            to="/"
            className="sidebar-header-back-btn"
            aria-label="Back to experiments"
          >
            <BackIcon />
          </Link>
          <h1 className="sidebar-header-title">{displayName}</h1>
        </div>
      </div>
      <div className="sidebar-list-section">
        <p className="sidebar-list-label">Runs</p>
        <nav className="p-2 flex-1 overflow-auto">
          {filteredRuns === undefined ? (
            <div className="text-slate-400 text-sm px-2">Loading runs...</div>
          ) : (
            filteredRuns.slice(0, 50).map((run) => (
              <RunLinkRow
                key={run._id}
                experimentId={experimentId}
                run={run}
                isActive={false}
              />
            ))
          )}
        </nav>
      </div>
    </>
  );
}

function RunLinkRow({
  experimentId,
  run,
  isActive,
}: {
  experimentId: string;
  run: Run;
  isActive: boolean;
}) {
  const passRate = run.evalCounts
    ? run.evalCounts.total > 0
      ? run.evalCounts.passed / run.evalCounts.total
      : 0
    : 0;
  const percentage = (passRate * 100).toFixed(1);
  const scoreStatus = getScoreStatus(passRate);
  const statusIcon = getRunStatusIcon(run.status);

  return (
    <Link
      to="/experiment/$experimentId/run/$runId"
      params={{ experimentId, runId: run._id }}
      className={`sidebar-item block mb-1 ${isActive ? "active" : ""}`}
    >
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-white truncate flex items-center gap-1">
          <span>{statusIcon}</span>
          {formatRunLabel(run._id, run.model)}
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
      <div className="text-xs text-slate-500 mt-1 flex items-center justify-between gap-2">
        <span>
          {run.evalCounts
            ? `${run.evalCounts.passed}/${run.evalCounts.total} passed`
            : "No evals"}
        </span>
        <span className="shrink-0">{formatRelativeTime(run._creationTime)}</span>
      </div>
    </Link>
  );
}

function SidebarRun({
  experimentId,
  runId,
}: {
  experimentId: string;
  runId: string;
}) {
  const run = useQuery(api.runs.getRunDetails, {
    runId: runId as Id<"runs">,
  });

  if (run === undefined) {
    return (
      <div className="p-4 text-slate-400 text-sm">Loading run...</div>
    );
  }

  if (run === null) {
    return (
      <div className="p-4 text-red-400 text-sm">Run not found</div>
    );
  }

  const evalsByCategory = new Map<string, Eval[]>();
  for (const evalItem of run.evals) {
    const cat = evalItem.category;
    if (!evalsByCategory.has(cat)) evalsByCategory.set(cat, []);
    evalsByCategory.get(cat)!.push(evalItem);
  }
  const categories = Array.from(evalsByCategory.keys()).sort();

  return (
    <>
      <div className="sidebar-header">
        <div className="sidebar-header-title-row">
          <Link
            to="/experiment/$experimentId"
            params={{ experimentId }}
            className="sidebar-header-back-btn"
            aria-label={`Back to ${experimentDisplayName(experimentId)}`}
          >
            <BackIcon />
          </Link>
          <h1 className="sidebar-header-title">{formatRunLabel(runId, run.model)}</h1>
        </div>
      </div>
      <div className="sidebar-list-section">
        <p className="sidebar-list-label">Categories ({categories.length})</p>
        <nav className="p-2 flex-1 overflow-auto">
          {categories.map((category) => {
            const evals = evalsByCategory.get(category)!;
            const passed = evals.filter((e) => e.status.kind === "passed").length;
            const total = evals.length;
            const icon =
              passed === total ? "✅" : passed === 0 ? "❌" : "⚠️";

            return (
              <Link
                key={category}
                to="/experiment/$experimentId/run/$runId/$category"
                params={{ experimentId, runId, category }}
                className="sidebar-item block mb-1"
                activeProps={{ className: "sidebar-item active block mb-1" }}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium text-white truncate flex items-center gap-1 min-w-0">
                    <span className="shrink-0">{icon}</span>
                    <span className="truncate">{formatCategoryName(category)}</span>
                  </span>
                  <span className="text-xs text-slate-500 shrink-0">
                    {passed}/{total}
                  </span>
                </div>
              </Link>
            );
          })}
        </nav>
      </div>
    </>
  );
}

function SidebarCategory({
  experimentId,
  runId,
  category,
}: {
  experimentId: string;
  runId: string;
  category: string;
}) {
  const run = useQuery(api.runs.getRunDetails, {
    runId: runId as Id<"runs">,
  });

  if (run === undefined) {
    return (
      <div className="p-4 text-slate-400 text-sm">Loading...</div>
    );
  }

  if (run === null) {
    return (
      <div className="p-4 text-red-400 text-sm">Run not found</div>
    );
  }

  const categoryEvals = run.evals
    .filter((e) => e.category === category)
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <>
      <div className="sidebar-header">
        <div className="sidebar-header-title-row">
          <Link
            to="/experiment/$experimentId/run/$runId"
            params={{ experimentId, runId }}
            className="sidebar-header-back-btn"
aria-label={`Back to ${formatRunLabel(runId, run.model)}`}
          >
            <BackIcon />
          </Link>
        <h1 className="sidebar-header-title">{formatCategoryName(category)}</h1>
        </div>
      </div>
      <div className="sidebar-list-section">
        <p className="sidebar-list-label">Evals ({categoryEvals.length})</p>
        <nav className="p-2 flex-1 overflow-auto">
          {categoryEvals.map((evalItem) => (
            <EvalLinkRow
              key={evalItem._id}
              experimentId={experimentId}
              runId={runId}
              evalItem={evalItem}
              isActive={false}
            />
          ))}
        </nav>
      </div>
    </>
  );
}

function SidebarEvalDetail({
  experimentId,
  runId,
  evalId,
}: {
  experimentId: string;
  runId: string;
  category: string;
  evalId: string;
}) {
  const run = useQuery(api.runs.getRunDetails, {
    runId: runId as Id<"runs">,
  });

  if (run === undefined) {
    return (
      <div className="p-4 text-slate-400 text-sm">Loading...</div>
    );
  }

  if (run === null) {
    return (
      <div className="p-4 text-red-400 text-sm">Run not found</div>
    );
  }

  const evals = [...run.evals].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <>
      <div className="sidebar-header">
        <div className="sidebar-header-title-row">
          <Link
            to="/experiment/$experimentId/run/$runId"
            params={{ experimentId, runId }}
            className="sidebar-header-back-btn"
aria-label={`Back to ${formatRunLabel(runId, run.model)}`}
          >
            <BackIcon />
          </Link>
        <h1 className="sidebar-header-title">Eval details</h1>
        </div>
      </div>
      <div className="sidebar-list-section">
        <p className="sidebar-list-label">Evals ({evals.length})</p>
        <nav className="p-2 flex-1 overflow-auto">
          {evals.map((evalItem) => (
            <EvalLinkRow
              key={evalItem._id}
              experimentId={experimentId}
              runId={runId}
              evalItem={evalItem}
              isActive={evalItem._id === evalId}
            />
          ))}
        </nav>
      </div>
    </>
  );
}

function EvalLinkRow({
  experimentId,
  runId,
  evalItem,
  isActive,
  model,
}: {
  experimentId: string;
  runId: string;
  evalItem: Eval;
  isActive: boolean;
  model?: string;
}) {
  const statusIcon = getEvalStatusIcon(evalItem.status);

  const linkProps = model
    ? {
        to: "/model/$model/experiment/$experimentId/run/$runId/$category/$evalId" as const,
        params: {
          model,
          experimentId,
          runId,
          category: evalItem.category,
          evalId: evalItem._id,
        },
      }
    : {
        to: "/experiment/$experimentId/run/$runId/$category/$evalId" as const,
        params: {
          experimentId,
          runId,
          category: evalItem.category,
          evalId: evalItem._id,
        },
      };

  return (
    <Link
      {...linkProps}
      search={{ tab: "steps" }}
      className={`sidebar-item block mb-1 ${isActive ? "active" : ""}`}
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
    </Link>
  );
}

// Model-based sidebar components

function SidebarModel({ model }: { model: string }) {
  const modelId = useResolvedModelId(model);
  const runs = useQuery(api.runs.listRuns, modelId ? { modelId } : "skip");

  if (modelId === null) {
    return <div className="p-4 text-slate-400 text-sm">Model not found.</div>;
  }

  if (modelId === undefined || runs === undefined) {
    return (
      <div className="p-4 text-slate-400 text-sm">Loading runs...</div>
    );
  }

  // Group runs by experiment
  const runsByExperiment = new Map<string, typeof runs>();
  for (const run of runs) {
    const expName = run.experiment ?? "default";
    if (!runsByExperiment.has(expName)) runsByExperiment.set(expName, []);
    runsByExperiment.get(expName)!.push(run);
  }
  const experiments = Array.from(runsByExperiment.keys()).sort();

  return (
    <>
      <div className="sidebar-header">
        <div className="sidebar-header-title-row">
          <Link
            to="/"
            className="sidebar-header-back-btn"
            aria-label="Back to home"
          >
            <BackIcon />
          </Link>
          <h1 className="sidebar-header-title">{model}</h1>
        </div>
      </div>
      <div className="sidebar-list-section">
        <p className="sidebar-list-label">Experiments ({experiments.length})</p>
        <nav className="p-2 flex-1 overflow-auto">
          {experiments.map((expName) => {
            const expRuns = runsByExperiment.get(expName)!;
            const passed = expRuns.reduce((acc, r) => acc + (r.evalCounts?.passed ?? 0), 0);
            const total = expRuns.reduce((acc, r) => acc + (r.evalCounts?.total ?? 0), 0);
            const passRate = total > 0 ? passed / total : 0;
            const percentage = (passRate * 100).toFixed(1);

            return (
              <Link
                key={expName}
                to="/model/$model/experiment/$experimentId"
                params={{ model, experimentId: expName }}
                className="sidebar-item block mb-1"
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-white truncate">
                    {experimentDisplayName(expName)}
                  </span>
                  <span className="text-xs font-bold text-cyan-400">
                    {percentage}%
                  </span>
                </div>
                <div className="text-xs text-slate-500 mt-1">
                  {expRuns.length} runs
                </div>
              </Link>
            );
          })}
        </nav>
      </div>
    </>
  );
}

function SidebarModelExperiment({
  model,
  experimentId,
}: {
  model: string;
  experimentId: string;
}) {
  const modelId = useResolvedModelId(model);
  const runs = useQuery(api.runs.listRuns, modelId ? { modelId } : "skip");

  if (modelId === null) {
    return <div className="p-4 text-slate-400 text-sm">Model not found.</div>;
  }

  const filteredRuns =
    runs === undefined
      ? undefined
      : experimentId === "default"
        ? runs.filter((r) => !r.experiment)
        : runs.filter((r) => r.experiment === experimentId);

  const displayName = experimentDisplayName(experimentId);

  return (
    <>
      <div className="sidebar-header">
        <div className="sidebar-header-title-row">
          <Link
            to="/model/$model"
            params={{ model }}
            className="sidebar-header-back-btn"
            aria-label={`Back to ${model}`}
          >
            <BackIcon />
          </Link>
          <h1 className="sidebar-header-title">{displayName}</h1>
        </div>
      </div>
      <div className="sidebar-list-section">
        <p className="sidebar-list-label">Runs</p>
        <nav className="p-2 flex-1 overflow-auto">
          {filteredRuns === undefined ? (
            <div className="text-slate-400 text-sm px-2">Loading runs...</div>
          ) : (
            filteredRuns.slice(0, 50).map((run) => (
              <ModelRunLinkRow
                key={run._id}
                model={model}
                experimentId={experimentId}
                run={run}
                isActive={false}
              />
            ))
          )}
        </nav>
      </div>
    </>
  );
}

function ModelRunLinkRow({
  model,
  experimentId,
  run,
  isActive,
}: {
  model: string;
  experimentId: string;
  run: Run;
  isActive: boolean;
}) {
  const passRate = run.evalCounts
    ? run.evalCounts.total > 0
      ? run.evalCounts.passed / run.evalCounts.total
      : 0
    : 0;
  const percentage = (passRate * 100).toFixed(1);
  const scoreStatus = getScoreStatus(passRate);
  const statusIcon = getRunStatusIcon(run.status);

  return (
    <Link
      to="/model/$model/experiment/$experimentId/run/$runId"
      params={{ model, experimentId, runId: run._id }}
      className={`sidebar-item block mb-1 ${isActive ? "active" : ""}`}
    >
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-white truncate flex items-center gap-1">
          <span>{statusIcon}</span>
          {formatRunLabel(run._id, run.model)}
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
      <div className="text-xs text-slate-500 mt-1 flex items-center justify-between gap-2">
        <span>
          {run.evalCounts
            ? `${run.evalCounts.passed}/${run.evalCounts.total} passed`
            : "No evals"}
        </span>
        <span className="shrink-0">{formatRelativeTime(run._creationTime)}</span>
      </div>
    </Link>
  );
}

function SidebarModelRun({
  model,
  experimentId,
  runId,
}: {
  model: string;
  experimentId: string;
  runId: string;
}) {
  const run = useQuery(api.runs.getRunDetails, {
    runId: runId as Id<"runs">,
  });

  if (run === undefined) {
    return (
      <div className="p-4 text-slate-400 text-sm">Loading run...</div>
    );
  }

  if (run === null) {
    return (
      <div className="p-4 text-red-400 text-sm">Run not found</div>
    );
  }

  const evalsByCategory = new Map<string, Eval[]>();
  for (const evalItem of run.evals) {
    const cat = evalItem.category;
    if (!evalsByCategory.has(cat)) evalsByCategory.set(cat, []);
    evalsByCategory.get(cat)!.push(evalItem);
  }
  const categories = Array.from(evalsByCategory.keys()).sort();

  return (
    <>
      <div className="sidebar-header">
        <div className="sidebar-header-title-row">
          <Link
            to="/model/$model/experiment/$experimentId"
            params={{ model, experimentId }}
            className="sidebar-header-back-btn"
            aria-label={`Back to ${experimentDisplayName(experimentId)}`}
          >
            <BackIcon />
          </Link>
          <h1 className="sidebar-header-title">{formatRunLabel(runId, run.model)}</h1>
        </div>
      </div>
      <div className="sidebar-list-section">
        <p className="sidebar-list-label">Categories ({categories.length})</p>
        <nav className="p-2 flex-1 overflow-auto">
          {categories.map((category) => {
            const evals = evalsByCategory.get(category)!;
            const passed = evals.filter((e) => e.status.kind === "passed").length;
            const total = evals.length;
            const icon =
              passed === total ? "✅" : passed === 0 ? "❌" : "⚠️";

            return (
              <Link
                key={category}
                to="/model/$model/experiment/$experimentId/run/$runId/$category"
                params={{ model, experimentId, runId, category }}
                className="sidebar-item block mb-1"
                activeProps={{ className: "sidebar-item active block mb-1" }}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium text-white truncate flex items-center gap-1 min-w-0">
                    <span className="shrink-0">{icon}</span>
                    <span className="truncate">{formatCategoryName(category)}</span>
                  </span>
                  <span className="text-xs text-slate-500 shrink-0">
                    {passed}/{total}
                  </span>
                </div>
              </Link>
            );
          })}
        </nav>
      </div>
    </>
  );
}

function SidebarModelCategory({
  model,
  experimentId,
  runId,
  category,
}: {
  model: string;
  experimentId: string;
  runId: string;
  category: string;
}) {
  const run = useQuery(api.runs.getRunDetails, {
    runId: runId as Id<"runs">,
  });

  if (run === undefined) {
    return (
      <div className="p-4 text-slate-400 text-sm">Loading...</div>
    );
  }

  if (run === null) {
    return (
      <div className="p-4 text-red-400 text-sm">Run not found</div>
    );
  }

  const categoryEvals = run.evals
    .filter((e) => e.category === category)
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <>
      <div className="sidebar-header">
        <div className="sidebar-header-title-row">
          <Link
            to="/model/$model/experiment/$experimentId/run/$runId"
            params={{ model, experimentId, runId }}
            className="sidebar-header-back-btn"
            aria-label={`Back to ${formatRunLabel(runId, run.model)}`}
          >
            <BackIcon />
          </Link>
          <h1 className="sidebar-header-title">{formatCategoryName(category)}</h1>
        </div>
      </div>
      <div className="sidebar-list-section">
        <p className="sidebar-list-label">Evals ({categoryEvals.length})</p>
        <nav className="p-2 flex-1 overflow-auto">
          {categoryEvals.map((evalItem) => (
            <EvalLinkRow
              key={evalItem._id}
              experimentId={experimentId}
              runId={runId}
              evalItem={evalItem}
              isActive={false}
              model={model}
            />
          ))}
        </nav>
      </div>
    </>
  );
}

function SidebarModelEvalDetail({
  model,
  experimentId,
  runId,
  evalId,
}: {
  model: string;
  experimentId: string;
  runId: string;
  category: string;
  evalId: string;
}) {
  const run = useQuery(api.runs.getRunDetails, {
    runId: runId as Id<"runs">,
  });

  if (run === undefined) {
    return (
      <div className="p-4 text-slate-400 text-sm">Loading...</div>
    );
  }

  if (run === null) {
    return (
      <div className="p-4 text-red-400 text-sm">Run not found</div>
    );
  }

  const evals = [...run.evals].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <>
      <div className="sidebar-header">
        <div className="sidebar-header-title-row">
          <Link
            to="/model/$model/experiment/$experimentId/run/$runId"
            params={{ model, experimentId, runId }}
            className="sidebar-header-back-btn"
            aria-label={`Back to ${formatRunLabel(runId, run.model)}`}
          >
            <BackIcon />
          </Link>
          <h1 className="sidebar-header-title">Eval details</h1>
        </div>
      </div>
      <div className="sidebar-list-section">
        <p className="sidebar-list-label">Evals ({evals.length})</p>
        <nav className="p-2 flex-1 overflow-auto">
          {evals.map((evalItem) => (
            <EvalLinkRow
              key={evalItem._id}
              experimentId={experimentId}
              runId={runId}
              evalItem={evalItem}
              isActive={evalItem._id === evalId}
              model={model}
            />
          ))}
        </nav>
      </div>
    </>
  );
}
