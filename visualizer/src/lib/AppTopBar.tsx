import { Link, useRouterState } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import { api } from "../convex/api";
import type { Id } from "../convex/types";
import { Breadcrumbs, type BreadcrumbCurrent } from "./breadcrumbs";

type SidebarLevel = "home" | "experiment" | "run" | "category" | "eval";

function parsePath(pathname: string): {
  level: SidebarLevel;
  experimentId?: string;
  runId?: string;
  category?: string;
  evalId?: string;
} {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0) return { level: "home" };
  if (segments[0] !== "experiment" || !segments[1]) return { level: "home" };

  const experimentId = segments[1];
  if (segments[2] !== "run" || !segments[3])
    return { level: "experiment", experimentId };

  const runId = segments[3];
  if (!segments[4]) return { level: "run", experimentId, runId };

  const category = segments[4];
  if (!segments[5]) return { level: "category", experimentId, runId, category };

  return {
    level: "eval",
    experimentId,
    runId,
    category,
    evalId: segments[5],
  };
}

export function AppTopBar() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const isDecision =
    pathname === "/decision" || pathname.startsWith("/decision/");
  const { level, experimentId, runId, category, evalId } = parsePath(pathname);

  const run = useQuery(
    api.runs.getRunDetails,
    runId ? { runId: runId as Id<"runs"> } : "skip",
  );

  const runModel = run && run !== null ? run.model : undefined;
  const evalName =
    level === "eval" && run && run !== null && evalId
      ? run.evals.find((e) => e._id === evalId)?.name
      : undefined;

  const current: BreadcrumbCurrent =
    level === "experiment"
      ? "experiment"
      : level === "run"
        ? "run"
        : level === "category"
          ? "category"
          : level === "eval"
            ? "eval"
            : "experiment";

  return (
    <header className="top-bar shrink-0 border-b border-slate-700 bg-slate-800/80">
      <div className="top-bar-inner">
        <Link to="/" className="top-bar-logo">
          Convex Evals
        </Link>
        <nav className="top-bar-breadcrumb" aria-label="Breadcrumb">
          {isDecision ? (
            <Link to="/decision" className="text-slate-300 hover:text-white">
              Decision runs
            </Link>
          ) : (
            <Breadcrumbs
              experimentId={level === "home" ? undefined : experimentId}
              runId={runId}
              runModel={runModel}
              category={category}
              evalName={evalName}
              current={level === "home" ? "experiment" : current}
            />
          )}
        </nav>
        <nav
          aria-label="Evaluation format"
          className="ml-auto flex gap-4 text-sm"
        >
          <Link to="/" className={isDecision ? "text-slate-400" : "text-white"}>
            Coding
          </Link>
          <Link
            to="/decision"
            className={isDecision ? "text-white" : "text-slate-400"}
          >
            Decision
          </Link>
        </nav>
      </div>
    </header>
  );
}
