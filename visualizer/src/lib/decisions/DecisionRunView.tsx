import { Link } from "@tanstack/react-router";
import { usePaginatedQuery, useQuery } from "convex/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { decisions, type DecisionRunDetails } from "../../convex/decisions";
import {
  buildSlots,
  cost,
  outcomeLabels,
  outcomeOf,
  parseSource,
  taskName,
  type Outcome,
  type Slot,
} from "./data";
import { OutcomeBadge, QuestionDetail } from "./QuestionDetail";
import { useArtifact } from "./useArtifact";

export type DecisionSearch = { question?: string; repetition?: number };
export function parseDecisionSearch(
  search: Record<string, unknown>,
): DecisionSearch {
  const repetition = Number(search.repetition ?? 0);
  return {
    question: typeof search.question === "string" ? search.question : undefined,
    repetition:
      Number.isSafeInteger(repetition) && repetition >= 0 ? repetition : 0,
  };
}
export function DecisionRunView({
  runId,
  search,
}: {
  runId: string;
  search: DecisionSearch;
}) {
  const run = useQuery(decisions.run, { runId });
  if (run === undefined)
    return <main className="p-6 text-slate-400">Loading decision run…</main>;
  if (run === null)
    return (
      <main className="p-6">
        <h1 className="text-xl">Run not found</h1>
        <Link className="text-cyan-400" to="/decision">
          Browse decision runs
        </Link>
      </main>
    );
  return <LoadedRun key={runId} run={run} search={search} />;
}
function LoadedRun({
  run,
  search,
}: {
  run: DecisionRunDetails;
  search: DecisionSearch;
}) {
  const outcomes = usePaginatedQuery(
    decisions.results,
    { runId: run._id },
    { initialNumItems: 100 },
  );
  // The task browser needs all outcomes, but raw artifacts are fetched only for
  // the selected question. This stays paginated at the backend boundary.
  useEffect(() => {
    if (outcomes.status === "CanLoadMore") outcomes.loadMore(100);
  }, [outcomes.status, outcomes.loadMore]);
  const parse = useCallback(
    (value: unknown) => parseSource(value, run.benchmarkVersion),
    [run.benchmarkVersion],
  );
  const source = useArtifact(run.sourceEvidenceUrl, parse);
  const [filter, setFilter] = useState<Outcome | "all">("all");
  const [query, setQuery] = useState("");
  const slots = useMemo(
    () =>
      buildSlots(
        run.plannedQuestions,
        run.profile.repetitions,
        outcomes.results,
      ),
    [run.plannedQuestions, run.profile.repetitions, outcomes.results],
  );
  const loaded = outcomes.status === "Exhausted";
  const selected = slots.find(
    (slot) =>
      slot.questionKey === search.question &&
      slot.repetition === (search.repetition ?? 0),
  );
  const groups = new Map<string, Slot[]>();
  for (const slot of slots) {
    if (
      filter !== "all" &&
      ((!loaded && !slot.result) || outcomeOf(slot.result) !== filter)
    )
      continue;
    const question = source.data?.questions.get(slot.questionKey);
    if (
      query &&
      !`${slot.questionKey} ${taskName(slot.sourceEval)} ${question?.concept ?? ""} ${question?.question ?? ""}`
        .toLowerCase()
        .includes(query.toLowerCase())
    )
      continue;
    groups.set(slot.sourceEval, [...(groups.get(slot.sourceEval) ?? []), slot]);
  }
  const selectedQuestion =
    selected && source.data?.questions.get(selected.questionKey);
  const summary = run.summary;
  return (
    <main className="flex min-w-0 flex-1 flex-col overflow-auto">
      <header className="border-b border-slate-700 px-5 py-4">
        <Link
          to="/decision"
          search={{ benchmark: run.benchmarkVersion }}
          className="text-sm text-cyan-400"
        >
          ← Decision runs
        </Link>
        <div className="mt-2 flex flex-wrap items-baseline justify-between gap-3">
          <h1 className="text-xl font-bold">{run.formattedName}</h1>
          <p className="text-sm text-slate-400">
            {new Date(run._creationTime).toLocaleString()} · {run.status}
          </p>
        </div>
        <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm text-slate-300">
          <span>
            <strong className="text-white">
              {summary ? `${(summary.score * 100).toFixed(1)}%` : "Pending"}
            </strong>{" "}
            source-weighted score
          </span>
          <span>
            {summary?.correctQuestions ??
              outcomes.results.filter((r) => r.correct).length}{" "}
            / {run.plannedQuestionCount} correct answers
          </span>
          <span>
            {run.plannedSourceCount} tasks · {run.plannedQuestions.length}{" "}
            questions · {run.profile.repetitions} repetitions
          </span>
          <span>
            {summary?.estimatedCostUsd !== undefined
              ? `~${cost(summary.estimatedCostUsd)}`
              : cost(summary?.costUsd)}{" "}
            per run
          </span>
        </div>
        <details className="mt-3 text-sm text-slate-400">
          <summary className="cursor-pointer">Run details</summary>
          <dl className="mt-2 grid gap-2 break-all sm:grid-cols-[auto_1fr]">
            <dt>Run</dt>
            <dd>{run._id}</dd>
            <dt>Benchmark</dt>
            <dd>{run.benchmarkVersion}</dd>
            <dt>Condition</dt>
            <dd>
              {run.condition === "no_guidelines"
                ? "No guidelines"
                : "With guidelines"}
            </dd>
            <dt>Leaderboard</dt>
            <dd>{run.leaderboardEligible ? "Eligible" : "Excluded"}</dd>
          </dl>
          <p className="mt-2">
            The score averages questions within each task, then weights tasks
            equally. The correct-answer count is unweighted.
          </p>
          {summary?.estimatedCostUsd !== undefined && (
            <p className="mt-2">
              ~ includes estimated costs for failed requests, not confirmed
              provider billing.
            </p>
          )}
          <div className="mt-2 flex gap-4">
            {run.sourceEvidenceUrl && (
              <a
                className="text-cyan-400 underline"
                href={run.sourceEvidenceUrl}
                target="_blank"
                rel="noreferrer"
              >
                Source snapshot ↗
              </a>
            )}
            {run.runEvidenceUrl && (
              <a
                className="text-cyan-400 underline"
                href={run.runEvidenceUrl}
                target="_blank"
                rel="noreferrer"
              >
                Run manifest ↗
              </a>
            )}
          </div>
        </details>
        {run.failureReason && (
          <p role="alert" className="mt-3 text-amber-200">
            {run.failureReason}
          </p>
        )}
      </header>
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <aside
          className="flex max-h-72 shrink-0 flex-col border-b border-slate-700 bg-slate-800/30 lg:max-h-none lg:w-80 lg:border-r lg:border-b-0"
          aria-label="Tasks and questions"
        >
          <div className="space-y-2 border-b border-slate-700 p-3">
            <input
              aria-label="Search tasks and questions"
              placeholder="Search tasks and questions"
              className="w-full rounded border border-slate-600 bg-slate-900 px-3 py-2 text-sm"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <select
              aria-label="Filter question outcomes"
              className="w-full rounded border border-slate-600 bg-slate-900 px-3 py-2 text-sm"
              value={filter}
              onChange={(event) =>
                setFilter(event.target.value as Outcome | "all")
              }
            >
              <option value="all">All outcomes</option>
              {Object.entries(outcomeLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <Link
              to="/decision/run/$runId"
              params={{ runId: run._id }}
              search={{}}
              className="block pt-1 text-sm text-cyan-400"
            >
              Run overview
            </Link>
          </div>
          <nav
            className="flex-1 overflow-auto p-2"
            aria-label="Question outcomes"
          >
            {!loaded && (
              <p className="p-2 text-sm text-slate-400">
                Loading outcomes… {outcomes.results.length} recorded
              </p>
            )}
            {groups.size === 0 && (
              <p className="p-2 text-sm text-slate-400">
                No matching questions.
              </p>
            )}
            {[...groups].map(([task, items]) => (
              <div key={task} className="mb-3">
                <h2 className="px-2 py-2 text-sm font-semibold text-slate-200">
                  {taskName(task)}
                </h2>
                {items.map((slot) => (
                  <Link
                    key={slot.key}
                    to="/decision/run/$runId"
                    params={{ runId: run._id }}
                    search={{
                      question: slot.questionKey,
                      repetition: slot.repetition,
                    }}
                    aria-current={
                      slot.key === selected?.key ? "page" : undefined
                    }
                    className={`block rounded-md px-2 py-2 text-sm hover:bg-slate-700/50 ${slot.key === selected?.key ? "bg-cyan-500/15 ring-1 ring-inset ring-cyan-500/50" : ""}`}
                  >
                    <span className="block truncate">
                      {source.data?.questions.get(slot.questionKey)?.concept ??
                        slot.questionKey.split("/").at(-1)}
                    </span>
                    <span className="mt-1 flex items-center justify-between gap-2 text-xs text-slate-400">
                      <span>Repetition {slot.repetition + 1}</span>
                      {slot.result || loaded ? (
                        <OutcomeBadge row={slot.result} />
                      ) : (
                        "Loading…"
                      )}
                    </span>
                  </Link>
                ))}
              </div>
            ))}
          </nav>
        </aside>
        <section
          key={selected?.key ?? "overview"}
          className="min-w-0 flex-1 overflow-auto p-5 lg:p-8"
          aria-label="Decision result"
        >
          {source.error && (
            <p role="alert" className="mb-5 text-amber-200">
              {source.error}
            </p>
          )}
          {!source.data && !source.error && (
            <p className="mb-5 text-slate-400">
              Loading the saved question bank…
            </p>
          )}
          {search.question ? (
            selected ? (
              <div className="mx-auto max-w-4xl">
                <p className="mb-2 text-sm text-slate-400">
                  {taskName(selected.sourceEval)} · Repetition{" "}
                  {selected.repetition + 1}
                </p>
                <h2 className="mb-5 text-2xl font-semibold">
                  {selectedQuestion?.concept ??
                    selected.questionKey.split("/").at(-1)}
                </h2>
                <div
                  className="mb-5 flex flex-wrap gap-2"
                  aria-label="Repetitions"
                >
                  {slots
                    .filter((slot) => slot.questionKey === selected.questionKey)
                    .map((slot) => (
                      <Link
                        key={slot.key}
                        to="/decision/run/$runId"
                        params={{ runId: run._id }}
                        search={{
                          question: slot.questionKey,
                          repetition: slot.repetition,
                        }}
                        aria-current={
                          slot.key === selected.key ? "page" : undefined
                        }
                        className={`rounded border px-3 py-1.5 text-sm ${slot.key === selected.key ? "border-cyan-500 bg-cyan-500/10" : "border-slate-600"}`}
                      >
                        Repetition {slot.repetition + 1}
                      </Link>
                    ))}
                </div>
                {!selected.result && !loaded ? (
                  <p>Loading this outcome…</p>
                ) : (
                  <QuestionDetail
                    runId={run._id}
                    row={selected.result}
                    question={selectedQuestion}
                    task={source.data?.tasks.get(selected.sourceEval)}
                  />
                )}
              </div>
            ) : (
              <p role="alert">
                This question or repetition is not part of this run.
              </p>
            )
          ) : (
            <>
              <h2 className="mb-4 text-xl font-semibold">Tasks</h2>
              <p className="mb-5 text-sm text-slate-400">
                Select a question to inspect the exact choices, the model’s
                answer, and the explanation.
              </p>
              <div className="overflow-x-auto">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Task</th>
                      <th>Correct / planned answers</th>
                      <th>Review</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...groups].map(([task, items]) => {
                      // Filtering changes which tasks are visible, not their
                      // score denominator or total number of planned answers.
                      const taskSlots = slots.filter(
                        (slot) => slot.sourceEval === task,
                      );
                      const first =
                        items.find(
                          (item) =>
                            item.result && outcomeOf(item.result) !== "correct",
                        ) ?? items[0];
                      return (
                        <tr key={task}>
                          <td>{taskName(task)}</td>
                          <td>
                            {loaded
                              ? taskSlots.filter((item) => item.result?.correct)
                                  .length
                              : "Loading…"}
                            {" / "}
                            {taskSlots.length}
                          </td>
                          <td>
                            <Link
                              className="text-cyan-400 underline"
                              to="/decision/run/$runId"
                              params={{ runId: run._id }}
                              search={{
                                question: first.questionKey,
                                repetition: first.repetition,
                              }}
                            >
                              View questions
                            </Link>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </section>
      </div>
    </main>
  );
}
