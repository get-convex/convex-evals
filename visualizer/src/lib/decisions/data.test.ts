import { describe, expect, it } from "vitest";
import type { DecisionResult } from "../../convex/decisions";
import {
  buildSlots,
  matchOptions,
  outcomeOf,
  parseEvidence,
  parseSource,
  type Question,
} from "./data";

const question: Question = {
  id: "q1",
  concept: "Transactions",
  context: "```ts\nawait write();\n```",
  question: "Which transaction commits?",
  correctOptionId: "c",
  options: ["a", "b", "c", "d"].map((id) => ({
    id,
    text: `Option ${id}`,
    rationale: `Reason ${id}`,
  })),
};
const row: DecisionResult = {
  _id: "result",
  questionKey: "003-mutations/000-task/q1",
  sourceEval: "003-mutations/000-task",
  questionId: "q1",
  repetition: 1,
  outcome: "answered",
  selectedCanonicalId: "a",
  expectedCanonicalId: "c",
  correct: false,
  durationMs: 100,
  requestAttempts: 1,
  costUsd: null,
  knownCostUsd: 0,
  evidenceUrl: "https://example.invalid/result",
};
const state = { context: question.context };
const options = { A: "Option c", B: "Option d", C: "Option a", D: "Option b" };
function envelope(native: boolean) {
  return {
    artifactVersion: 1,
    kind: "decision-question",
    runId: "run",
    key: `${row.questionKey}/1`,
    request: native
      ? {
          state,
          questions: {
            decision: { instructions: question.question, criteria: options },
          },
        }
      : {
          messages: [
            {
              role: "user",
              content: JSON.stringify({
                state,
                question: question.question,
                options,
              }),
            },
          ],
        },
    result: {
      key: `${row.questionKey}/1`,
      kind: "answered",
      correct: false,
      selectedCanonicalId: "a",
      expectedCanonicalId: "c",
      outcome: {
        answer: {
          choice: "C",
          probabilities: native ? { A: 0.1, B: 0.1, C: 0.7, D: 0.1 } : null,
        },
        error: null,
      },
    },
  };
}
describe("decision evidence", () => {
  it.each([true, false])(
    "maps shuffled display labels without confusing them with canonical IDs (native=%s)",
    (native) => {
      const parsed = parseEvidence(envelope(native), "run", row);
      const matched = matchOptions(question, parsed, row);
      expect(matched.find((option) => option.correct)?.label).toBe("A");
      expect(matched.find((option) => option.selected)?.label).toBe("C");
      expect(matched.find((option) => option.selected)?.rationale).toBe(
        "Reason a",
      );
      expect(parsed.probabilities).toEqual(
        native ? { A: 0.1, B: 0.1, C: 0.7, D: 0.1 } : null,
      );
    },
  );
  it("rejects evidence from another run or repetition", () => {
    expect(() => parseEvidence(envelope(true), "other-run", row)).toThrow(
      "does not match",
    );
    expect(() =>
      parseEvidence(envelope(true), "run", { ...row, repetition: 0 }),
    ).toThrow("does not match");
  });
  it("does not annotate mismatched or repeated option text as a correct answer", () => {
    const parsed = parseEvidence(envelope(true), "run", row);
    parsed.options[0].text = "Different question";
    expect(() => matchOptions(question, parsed, row)).toThrow("Cannot match");
    parsed.options[0].text = parsed.options[1].text;
    expect(() => matchOptions(question, parsed, row)).toThrow("differs");
  });
  it("detects a choice that contradicts the stored selected canonical ID", () => {
    const value = envelope(true);
    value.result.outcome.answer.choice = "A";
    expect(() =>
      matchOptions(question, parseEvidence(value, "run", row), row),
    ).toThrow("differs");
  });
  it.each(["provider_error", "invalid_response"] as const)(
    "preserves %s without inventing a selected answer",
    (outcome) => {
      const value = {
        ...envelope(true),
        result: {
          ...envelope(true).result,
          kind: outcome,
          selectedCanonicalId: null,
          outcome: { answer: null, error: "Provider failed" },
        },
      };
      const result = { ...row, outcome, selectedCanonicalId: null };
      const parsed = parseEvidence(value, "run", result);
      expect(parsed.choice).toBeNull();
      expect(outcomeOf(result)).toBe(outcome);
      expect(
        matchOptions(question, parsed, result).some(
          (option) => option.selected,
        ),
      ).toBe(false);
    },
  );
  it("preserves planned but unrecorded repetitions", () => {
    const slots = buildSlots([row.questionKey], 3, [row]);
    expect(slots).toHaveLength(3);
    expect(slots.map((slot) => outcomeOf(slot.result))).toEqual([
      "missing",
      "incorrect",
      "missing",
    ]);
    expect(slots[1].sourceEval).toBe(row.sourceEval);
  });
  it("reads the original task from the same immutable benchmark as the questions", () => {
    const source = {
      kind: "decision-source",
      artifactVersion: 2,
      benchmark: { version: "version" },
      banks: [{ sourceEval: row.sourceEval, questions: [question] }],
      files: [
        {
          path: `evals/${row.sourceEval}/TASK.txt`,
          encoding: "utf8",
          content: "Build a task",
        },
      ],
    };
    const parsed = parseSource(source, "version");
    expect(parsed.questions.get(row.questionKey)).toEqual(question);
    expect(parsed.tasks.get(row.sourceEval)).toBe("Build a task");
    expect(() => parseSource(source, "different-version")).toThrow(
      "does not match",
    );
  });
});
