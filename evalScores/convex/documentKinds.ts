import type { Doc } from "./_generated/dataModel.js";

export type CodingRun = Extract<Doc<"runs">, { kind: "coding" }>;
export type CodingEval = Extract<Doc<"evals">, { kind: "coding" }>;
export type CodingModelScore = Extract<Doc<"modelScores">, { kind: "coding" }>;
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

export function isCodingRun(run: Doc<"runs">): run is CodingRun {
  switch (run.kind) {
    case "coding":
      return true;
    case "decision":
      return false;
    default:
      return assertNever(run);
  }
}

export function isCodingEval(evalDoc: Doc<"evals">): evalDoc is CodingEval {
  switch (evalDoc.kind) {
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
): score is CodingModelScore {
  switch (score.kind) {
    case "coding":
      return true;
    case "decision":
      return false;
    default:
      return assertNever(score);
  }
}

export function requireCodingRun(run: Doc<"runs">): CodingRun {
  switch (run.kind) {
    case "coding":
      return run;
    case "decision":
      throw new Error("This operation requires a coding run");
    default:
      return assertNever(run);
  }
}

export function requireCodingEval(evalDoc: Doc<"evals">): CodingEval {
  switch (evalDoc.kind) {
    case "coding":
      return evalDoc;
    case "decision":
      throw new Error("This operation requires a coding eval");
    default:
      return assertNever(evalDoc);
  }
}

export function requireDecisionRun(run: Doc<"runs">): DecisionRun {
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
  score: Doc<"modelScores">,
): CodingModelScore {
  switch (score.kind) {
    case "coding":
      return score;
    case "decision":
      throw new Error("This operation requires a coding score");
    default:
      return assertNever(score);
  }
}

export function requireDecisionResult(evalDoc: Doc<"evals">): DecisionResult {
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
  score: Doc<"modelScores">,
): DecisionModelScore {
  switch (score.kind) {
    case "decision":
      return score;
    case "coding":
      throw new Error("This operation requires a decision score");
    default:
      return assertNever(score);
  }
}
