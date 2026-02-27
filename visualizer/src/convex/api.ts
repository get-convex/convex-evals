/* eslint-disable */
/**
 * Convex API types for the evalScores backend.
 *
 * This is a simplified version that provides type-safe API references
 * without needing to import from the evalScores directory.
 */

import { anyApi } from "convex/server";
import type { FunctionReference } from "convex/server";
import type { Id } from "./types";
import type { Run, Eval, Step } from "../lib/types";

// Experiment stats returned by listExperiments
type ExperimentInfo = {
  name: string;
  runCount: number;
  modelCount: number;
  models: string[];
  latestRun: number;
  totalEvals: number;
  passedEvals: number;
  passRate: number;
  completedRuns: number;
};

// Model stats returned by listModels
type ModelInfo = {
  name: string;
  runCount: number;
  experimentCount: number;
  experiments: string[];
  latestRun: number;
  totalEvals: number;
  passedEvals: number;
  passRate: number;
};

// Run returned by listRuns (always has evalCounts, never has evals array)
export type RunWithCounts = Omit<Run, "evals"> & {
  evalCounts: {
    total: number;
    passed: number;
    failed: number;
    pending: number;
  };
};

// Eval returned by getRunDetails (always has steps)
export type EvalWithSteps = Omit<Eval, "steps"> & {
  steps: Step[];
};

// Run returned by getRunDetails (always has evals with steps, no evalCounts)
export type RunDetails = Omit<Run, "evals" | "evalCounts"> & {
  evals: EvalWithSteps[];
};

type QueryRef<
  Args extends Record<string, unknown>,
  ReturnType,
> = FunctionReference<"query", "public", Args, ReturnType>;

/**
 * A utility for referencing Convex functions in your app's API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export const api = anyApi as unknown as {
  runs: {
    listExperiments: QueryRef<Record<string, never>, ExperimentInfo[]>;
    listModels: QueryRef<{ models: string[] }, ModelInfo[]>;
    listRuns: QueryRef<
      { experiment?: string; model?: string; limit?: number },
      RunWithCounts[]
    >;
    getRunDetails: QueryRef<{ runId: Id<"runs"> }, RunDetails | null>;
    getOutputUrl: QueryRef<{ storageId: Id<"_storage"> }, string | null>;
  };
};

export const internal = anyApi;
