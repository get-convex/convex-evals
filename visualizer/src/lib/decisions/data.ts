import type { DecisionResult } from "../../convex/decisions";

export type Question = {
  id: string;
  concept: string;
  context: string;
  question: string;
  correctOptionId: string;
  options: { id: string; text: string; rationale: string }[];
};
export type SourceSnapshot = {
  questions: Map<string, Question>;
  tasks: Map<string, string>;
};
export type QuestionEvidence = {
  raw: unknown;
  request: unknown;
  context: string;
  question: string;
  options: { label: string; text: string }[];
  choice: string | null;
  probabilities: Record<string, number> | null;
  error: string | null;
};
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected an evidence object.");
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected evidence text.");
  return value;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Expected an evidence list.");
  return value;
}

export function parseSource(value: unknown, benchmark: string): SourceSnapshot {
  const source = object(value);
  if (
    source.kind !== "decision-source" ||
    ![1, 2].includes(Number(source.artifactVersion)) ||
    object(source.benchmark).version !== benchmark
  ) {
    throw new Error("Question bank does not match this benchmark.");
  }
  const questions = new Map<string, Question>();
  for (const entry of array(source.banks)) {
    const bank = object(entry);
    for (const item of array(bank.questions)) {
      const q = object(item);
      const options = array(q.options).map((item) => {
        const option = object(item);
        return {
          id: text(option.id),
          text: text(option.text),
          rationale: text(option.rationale),
        };
      });
      const question: Question = {
        id: text(q.id),
        concept: text(q.concept),
        context: text(q.context),
        question: text(q.question),
        correctOptionId: text(q.correctOptionId),
        options,
      };
      if (
        options.length !== 4 ||
        new Set(options.map((o) => o.id)).size !== 4 ||
        !options.some((o) => o.id === question.correctOptionId)
      ) {
        throw new Error("Question bank has an invalid answer key.");
      }
      const key = `${text(bank.sourceEval)}/${question.id}`;
      if (questions.has(key))
        throw new Error("Question bank contains duplicate questions.");
      questions.set(key, question);
    }
  }
  const tasks = new Map<string, string>();
  for (const entry of array(source.files)) {
    const file = object(entry);
    const path = text(file.path);
    if (
      path.startsWith("evals/") &&
      path.endsWith("/TASK.txt") &&
      file.encoding === "utf8"
    ) {
      tasks.set(path.slice(6, -9), text(file.content));
    }
  }
  return { questions, tasks };
}

export function parseEvidence(
  value: unknown,
  runId: string,
  row: DecisionResult,
): QuestionEvidence {
  const envelope = object(value);
  const key = `${row.questionKey}/${row.repetition}`;
  const result = object(envelope.result);
  if (
    envelope.artifactVersion !== 1 ||
    envelope.kind !== "decision-question" ||
    envelope.runId !== runId ||
    envelope.key !== key ||
    result.key !== key ||
    result.kind !== row.outcome ||
    result.selectedCanonicalId !== row.selectedCanonicalId ||
    result.expectedCanonicalId !== row.expectedCanonicalId ||
    result.correct !== row.correct
  ) {
    throw new Error("Evidence does not match this question outcome.");
  }
  const request = object(envelope.request);
  let state: Record<string, unknown>;
  let question: string;
  let options: Record<string, unknown>;
  if (request.questions) {
    const decision = object(object(request.questions).decision);
    state = object(request.state);
    question = text(decision.instructions);
    options = object(decision.criteria);
  } else {
    const message = array(request.messages)
      .map(object)
      .find((m) => m.role === "user");
    const input = object(JSON.parse(text(message?.content)));
    state = object(input.state);
    question = text(input.question);
    options = object(input.options);
  }
  const outcome = object(result.outcome);
  const answer = outcome.answer ? object(outcome.answer) : null;
  const displayed = Object.entries(options).map(([label, value]) => ({
    label,
    text: text(value),
  }));
  if (displayed.length !== 4 || displayed.some((o) => !/^[A-D]$/.test(o.label)))
    throw new Error("Unexpected displayed choices.");
  const probabilities = answer?.probabilities
    ? object(answer.probabilities)
    : null;
  if (
    probabilities &&
    Object.entries(probabilities).some(
      ([label, value]) =>
        !/^[A-D]$/.test(label) ||
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < 0 ||
        value > 1,
    )
  ) {
    throw new Error("Invalid reported probabilities.");
  }
  const choice = answer ? text(answer.choice) : null;
  if (choice && !displayed.some((o) => o.label === choice))
    throw new Error("Unknown selected choice.");
  return {
    raw: value,
    request,
    context: text(state.context),
    question,
    options: displayed,
    choice,
    probabilities: probabilities as Record<string, number> | null,
    error: outcome.error === null ? null : text(outcome.error),
  };
}

// Display letters are shuffled for every repetition. Match the recorded text to
// the immutable bank, never assume display A means canonical option "a".
export function matchOptions(
  question: Question,
  evidence: QuestionEvidence,
  row: DecisionResult,
) {
  if (
    question.context !== evidence.context ||
    question.question !== evidence.question ||
    question.correctOptionId !== row.expectedCanonicalId
  )
    throw new Error(
      "Question text or answer key differs from the saved request.",
    );
  const options = evidence.options.map((displayed) => {
    const matches = question.options.filter((o) => o.text === displayed.text);
    if (matches.length !== 1)
      throw new Error(
        "Cannot match the shuffled choices to the question bank.",
      );
    const canonical = matches[0];
    return {
      ...canonical,
      label: displayed.label,
      selected: canonical.id === row.selectedCanonicalId,
      correct: canonical.id === row.expectedCanonicalId,
      probability: evidence.probabilities?.[displayed.label],
    };
  });
  if (
    new Set(options.map((o) => o.id)).size !== 4 ||
    (evidence.choice !== null &&
      options.find((o) => o.label === evidence.choice)?.id !==
        row.selectedCanonicalId)
  )
    throw new Error("Selected choice differs from the recorded outcome.");
  return options;
}

export type Outcome =
  "correct" | "incorrect" | "invalid_response" | "provider_error" | "missing";
export const outcomeLabels: Record<Outcome, string> = {
  correct: "Correct",
  incorrect: "Incorrect",
  invalid_response: "Invalid response",
  provider_error: "Provider error",
  missing: "Not recorded",
};
export function outcomeOf(row?: DecisionResult): Outcome {
  return !row
    ? "missing"
    : row.outcome === "answered"
      ? row.correct
        ? "correct"
        : "incorrect"
      : row.outcome;
}
export type Slot = {
  key: string;
  questionKey: string;
  sourceEval: string;
  repetition: number;
  result?: DecisionResult;
};
export function buildSlots(
  planned: string[],
  repetitions: number,
  results: DecisionResult[],
): Slot[] {
  const byKey = new Map(
    results.map((row) => [`${row.questionKey}/${row.repetition}`, row]),
  );
  return planned.flatMap((questionKey) =>
    Array.from({ length: repetitions }, (_, repetition) => {
      const key = `${questionKey}/${repetition}`;
      return {
        key,
        questionKey,
        repetition,
        sourceEval: questionKey.slice(0, questionKey.lastIndexOf("/")),
        result: byKey.get(key),
      };
    }),
  );
}
export function taskName(path: string) {
  return path
    .split("/")
    .map((part) => {
      const name = part.replace(/^\d+-/, "").replaceAll("_", " ");
      return name.charAt(0).toUpperCase() + name.slice(1);
    })
    .join(" / ");
}
export function cost(value: number | null | undefined) {
  return value == null
    ? "Unknown"
    : `$${value.toLocaleString(
        "en-US",
        value > 0 && value < 1
          ? { maximumSignificantDigits: 4 }
          : { maximumFractionDigits: 2, minimumFractionDigits: 2 },
      )}`;
}
