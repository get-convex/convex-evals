import type { DecisionResult } from "../../convex/decisions";
import {
  cost,
  matchOptions,
  outcomeLabels,
  outcomeOf,
  parseEvidence,
  type Question,
  type QuestionEvidence,
} from "./data";
import { useArtifact } from "./useArtifact";

// Render prose and fenced code as React text, never as HTML from an artifact.
export function QuestionText({ text }: { text: string }) {
  return (
    <div className="space-y-3 leading-relaxed">
      {text
        .split(/(```[\s\S]*?```)/g)
        .filter(Boolean)
        .map((part, i) =>
          part.startsWith("```") ? (
            <pre
              key={i}
              className="overflow-x-auto rounded-lg border border-slate-700 bg-slate-950 p-4 text-sm leading-6"
            >
              <code>
                {part
                  .replace(/^```[^\n]*\n?/, "")
                  .replace(/```$/, "")
                  .trimEnd()}
              </code>
            </pre>
          ) : (
            <p key={i} className="whitespace-pre-wrap break-words">
              {part}
            </p>
          ),
        )}
    </div>
  );
}
export function OutcomeBadge({ row }: { row?: DecisionResult }) {
  const kind = outcomeOf(row);
  const color =
    kind === "correct"
      ? "bg-green-500/10 text-green-300"
      : kind === "incorrect"
        ? "bg-red-500/10 text-red-300"
        : "bg-slate-700 text-slate-300";
  return (
    <span
      className={`inline-flex rounded px-2 py-1 text-xs font-medium ${color}`}
    >
      {outcomeLabels[kind]}
    </span>
  );
}
export function QuestionDetail({
  runId,
  row,
  question,
  task,
}: {
  runId: string;
  row?: DecisionResult;
  question?: Question;
  task?: string;
}) {
  if (!row)
    return (
      <div className="space-y-5">
        <p className="text-slate-400">
          No answer has been recorded for this repetition.
        </p>
        {question && (
          <>
            <QuestionText text={question.context} />
            <h2 className="text-xl font-semibold">{question.question}</h2>
          </>
        )}
      </div>
    );
  return (
    <RecordedQuestion
      key={row._id}
      runId={runId}
      row={row}
      question={question}
      task={task}
    />
  );
}
function RecordedQuestion({
  runId,
  row,
  question,
  task,
}: {
  runId: string;
  row: DecisionResult;
  question?: Question;
  task?: string;
}) {
  const evidence = useArtifact(row.evidenceUrl, (value) =>
    parseEvidence(value, runId, row),
  );
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3 text-sm text-slate-400">
        <OutcomeBadge row={row} />
        <span>{Math.round(row.durationMs).toLocaleString()} ms</span>
        <span>
          {cost(row.costUsd)}
          {row.costUsd === null && row.knownCostUsd > 0
            ? ` (${cost(row.knownCostUsd)} reported)`
            : ""}
        </span>
        <span>
          {row.requestAttempts} request{row.requestAttempts === 1 ? "" : "s"}
        </span>
      </div>
      {evidence.error ? (
        <p
          role="alert"
          className="rounded border border-amber-700 p-4 text-amber-200"
        >
          {evidence.error} The recorded outcome above is still available.
        </p>
      ) : !evidence.data ? (
        <p className="text-slate-400">Loading question evidence…</p>
      ) : (
        <EvidenceContent
          evidence={evidence.data}
          row={row}
          question={question}
        />
      )}
      {task && (
        <details className="rounded-lg border border-slate-700 p-4">
          <summary className="cursor-pointer font-medium">
            Original coding task
          </summary>
          <div className="mt-4 text-slate-300">
            <QuestionText text={task} />
          </div>
        </details>
      )}
      <details className="rounded-lg border border-slate-700 p-4">
        <summary className="cursor-pointer font-medium">
          Raw request and response
        </summary>
        <p className="my-3 text-sm text-slate-400">
          The saved provider request and all response attempts for this
          question.
        </p>
        {row.evidenceUrl && (
          <a
            href={row.evidenceUrl}
            target="_blank"
            rel="noreferrer"
            className="text-cyan-400 underline"
          >
            Open raw JSON ↗
          </a>
        )}
        {evidence.data && (
          <pre className="mt-4 max-h-[36rem] overflow-auto whitespace-pre-wrap break-all text-xs text-slate-300">
            {JSON.stringify(evidence.data.raw, null, 2)}
          </pre>
        )}
      </details>
    </div>
  );
}
function EvidenceContent({
  evidence,
  row,
  question,
}: {
  evidence: QuestionEvidence;
  row: DecisionResult;
  question?: Question;
}) {
  let matched: ReturnType<typeof matchOptions> | undefined;
  let mismatch: string | undefined;
  if (question) {
    try {
      matched = matchOptions(question, evidence, row);
    } catch (error) {
      mismatch =
        error instanceof Error
          ? error.message
          : "Could not match the answer key.";
    }
  }
  return (
    <>
      {evidence.error && (
        <p
          role="alert"
          className="rounded border border-amber-700 p-4 text-amber-200"
        >
          {evidence.error}
        </p>
      )}
      <div className="text-slate-300">
        <QuestionText text={evidence.context} />
      </div>
      <h2 className="whitespace-pre-wrap text-xl font-semibold text-white">
        {evidence.question}
      </h2>
      {!matched && (
        <p role="alert" className="text-amber-200">
          {mismatch ??
            "The question bank is unavailable. Showing the saved choices without answer-key annotations."}
        </p>
      )}
      <div className="space-y-3" aria-label="Answer choices">
        {evidence.options.map((option) => {
          const canonical = matched?.find((o) => o.label === option.label);
          const selected = evidence.choice === option.label;
          const color = canonical?.correct
            ? "border-green-500/60 bg-green-500/5"
            : selected
              ? "border-red-400/60 bg-red-500/5"
              : "border-slate-700";
          const probability = evidence.probabilities?.[option.label];
          return (
            <article
              key={option.label}
              className={`rounded-lg border p-4 ${color}`}
            >
              <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
                <span className="font-bold">{option.label}</span>
                {selected && (
                  <span className="rounded bg-slate-700 px-2 py-0.5">
                    Model selected
                  </span>
                )}
                {canonical?.correct && (
                  <span className="rounded bg-green-500/10 px-2 py-0.5 text-green-300">
                    Correct answer
                  </span>
                )}
                {probability !== undefined && (
                  <span className="ml-auto text-slate-400">
                    {(probability * 100).toFixed(1)}% reported probability
                  </span>
                )}
              </div>
              <QuestionText text={option.text} />
              {canonical && (
                <details className="mt-3 text-sm text-slate-400">
                  <summary className="cursor-pointer">
                    Why {canonical.correct ? "this works" : "this is incorrect"}
                  </summary>
                  <p className="mt-2 whitespace-pre-wrap text-slate-300">
                    {canonical.rationale}
                  </p>
                </details>
              )}
            </article>
          );
        })}
      </div>
      <p className="text-xs text-slate-500">
        Choices appear in the order sent to the model. Answer explanations are
        review notes and were not included in the request.
      </p>
    </>
  );
}
