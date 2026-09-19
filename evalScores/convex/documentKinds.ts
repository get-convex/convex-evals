import type { Doc } from "./_generated/dataModel.js";

// Only the persistence boundary accepts historical records without a tag.
// Application dispatchers always see a strict discriminated union.
export type StoredCodingRun = Extract<Doc<"runs">, { kind?: "coding" }>;
export type StoredCodingEval = Extract<Doc<"evals">, { kind?: "coding" }>;
export type StoredCodingModelScore = Extract<
  Doc<"modelScores">,
  { kind?: "coding" }
>;
export type CodingRun = Omit<StoredCodingRun, "kind"> & { kind: "coding" };
export type CodingEval = Omit<StoredCodingEval, "kind"> & { kind: "coding" };
export type CodingModelScore = Omit<StoredCodingModelScore, "kind"> & {
  kind: "coding";
};
export type DecisionRun = Extract<Doc<"runs">, { kind: "decision" }>;
export type DecisionResult = Extract<Doc<"evals">, { kind: "decision" }>;
export type DecisionModelScore = Extract<
  Doc<"modelScores">,
  { kind: "decision" }
>;
export type Run = CodingRun | DecisionRun;
export type Eval = CodingEval | DecisionResult;
export type ModelScore = CodingModelScore | DecisionModelScore;

export function assertNever(_value: never): never {
  throw new Error("Unhandled document kind");
}

export function normalizeRun(run: Doc<"runs">): Run {
  switch (run.kind) {
    case undefined:
    case "coding":
      return { ...run, kind: "coding" };
    case "decision":
      return run;
    default:
      return assertNever(run);
  }
}

export function normalizeEval(evalDoc: Doc<"evals">): Eval {
  switch (evalDoc.kind) {
    case undefined:
    case "coding":
      return { ...evalDoc, kind: "coding" };
    case "decision":
      return evalDoc;
    default:
      return assertNever(evalDoc);
  }
}

export function normalizeModelScore(score: Doc<"modelScores">): ModelScore {
  switch (score.kind) {
    case undefined:
    case "coding":
      return { ...score, kind: "coding" };
    case "decision":
      return score;
    default:
      return assertNever(score);
  }
}

export function isCodingRun(run: Doc<"runs">): run is StoredCodingRun {
  switch (run.kind) {
    case undefined:
    case "coding":
      return true;
    case "decision":
      return false;
    default:
      return assertNever(run);
  }
}

export function isCodingEval(
  evalDoc: Doc<"evals">,
): evalDoc is StoredCodingEval {
  switch (evalDoc.kind) {
    case undefined:
    case "coding":
      return true;
    case "decision":
      return false;
    default:
      return assertNever(evalDoc);
  }
}

export function isCodingModelScore(
  score: Doc<"modelScores">,
): score is StoredCodingModelScore {
  switch (score.kind) {
    case undefined:
    case "coding":
      return true;
    case "decision":
      return false;
    default:
      return assertNever(score);
  }
}

export function requireCodingRun(value: Doc<"runs">): CodingRun {
  const run = normalizeRun(value);
  switch (run.kind) {
    case "coding":
      return run;
    case "decision":
      throw new Error("This operation requires a coding run");
    default:
      return assertNever(run);
  }
}

export function requireCodingEval(value: Doc<"evals">): CodingEval {
  const evalDoc = normalizeEval(value);
  switch (evalDoc.kind) {
    case "coding":
      return evalDoc;
    case "decision":
      throw new Error("This operation requires a coding eval");
    default:
      return assertNever(evalDoc);
  }
}

export function requireDecisionRun(value: Doc<"runs">): DecisionRun {
  const run = normalizeRun(value);
  switch (run.kind) {
    case "decision":
      return run;
    case "coding":
      throw new Error("This operation requires a decision run");
    default:
      return assertNever(run);
  }
}

export function requireCodingModelScore(
  value: Doc<"modelScores">,
): CodingModelScore {
  const score = normalizeModelScore(value);
  switch (score.kind) {
    case "coding":
      return score;
    case "decision":
      throw new Error("This operation requires a coding score");
    default:
      return assertNever(score);
  }
}

export function requireDecisionResult(value: Doc<"evals">): DecisionResult {
  const evalDoc = normalizeEval(value);
  switch (evalDoc.kind) {
    case "decision":
      return evalDoc;
    case "coding":
      throw new Error("This operation requires a decision result");
    default:
      return assertNever(evalDoc);
  }
}

export function requireDecisionModelScore(
  value: Doc<"modelScores">,
): DecisionModelScore {
  const score = normalizeModelScore(value);
  switch (score.kind) {
    case "decision":
      return score;
    case "coding":
      throw new Error("This operation requires a decision score");
    default:
      return assertNever(score);
  }
}
