import type {
  FunctionReference,
  PaginationOptions,
  PaginationResult,
} from "convex/server";

// Public, read-only contracts from evalScores/convex/decisionViews.ts. These
// deliberately do not use the coding run API, despite sharing storage tables.
export type DecisionVersion = {
  version: string;
  effectiveAt: number;
  isCurrent: boolean;
};
export type DecisionResult = {
  _id: string;
  questionKey: string;
  sourceEval: string;
  questionId: string;
  repetition: number;
  outcome: "answered" | "invalid_response" | "provider_error";
  selectedCanonicalId: string | null;
  expectedCanonicalId: string;
  correct: boolean;
  durationMs: number;
  requestAttempts: number;
  costUsd: number | null;
  knownCostUsd: number;
  evidenceUrl: string | null;
};
export type DecisionRun = {
  _id: string;
  _creationTime: number;
  formattedName: string;
  model: string;
  benchmarkVersion: string;
  condition: "no_guidelines" | "with_guidelines";
  status: "running" | "completed" | "interrupted";
  failureReason: string | null;
  leaderboardEligible: boolean;
  plannedQuestionCount: number;
  plannedSourceCount: number;
  profile: { repetitions: number };
  summary: {
    score: number;
    correctQuestions: number;
    completedQuestions: number;
    invalidResponses: number;
    providerErrors: number;
    costUsd: number | null;
    knownCostUsd: number;
    estimatedCostUsd?: number;
  } | null;
};
export type DecisionRunDetails = DecisionRun & {
  plannedQuestions: string[];
  sourceEvidenceUrl: string | null;
  runEvidenceUrl: string | null;
};
type Query<A extends Record<string, unknown>, R> = FunctionReference<
  "query",
  "public",
  A,
  R
>;
export const decisions = {
  versions: "decisionViews:decisionLeaderboardVersions" as unknown as Query<
    Record<string, never>,
    DecisionVersion[]
  >,
  runs: "runs:listDecisionRuns" as unknown as Query<
    {
      benchmarkVersion: string;
      condition: "no_guidelines" | "with_guidelines";
      paginationOpts: PaginationOptions;
    },
    PaginationResult<DecisionRun>
  >,
  run: "runs:getDecisionRun" as unknown as Query<
    { runId: string },
    DecisionRunDetails | null
  >,
  results: "evals:decisionResults" as unknown as Query<
    { runId: string; paginationOpts: PaginationOptions },
    PaginationResult<DecisionResult>
  >,
};
