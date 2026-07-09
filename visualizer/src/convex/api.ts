/* eslint-disable */
/**
 * Convex API types for the evalScores backend.
 *
 * This is a simplified version that provides type-safe API references
 * without needing to import from the evalScores directory.
 */

import { anyApi } from "convex/server";
import type { FunctionReference } from "convex/server";
import type { PaginationOptions, PaginationResult } from "convex/server";
import type { Id } from "./types";
import type { Run, Eval, Step } from "../lib/types";

// Experiment stats returned by listExperiments
type ExperimentInfo = {
  name: string;
  runCount: number;
  modelCount: number;
  models: Id<"models">[];
  latestRun: number;
  totalEvals: number;
  passedEvals: number;
  passRate: number;
  completedRuns: number;
};

type ModelDoc = {
  _id: Id<"models">;
  slug: string;
  formattedName: string;
  provider: string;
  apiKind: "chat" | "responses";
  openRouterFirstSeenAt: number;
  createdAt: number;
  updatedAt: number;
  lastSeenAt: number;
  _creationTime: number;
};

type ModelSummary = {
  runCount: number;
  experimentCount: number;
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
  models: {
    getBySlug: QueryRef<{ slug: string }, ModelDoc | null>;
    listModels: QueryRef<
      { paginationOpts: PaginationOptions },
      PaginationResult<ModelDoc>
    >;
  };
  runs: {
    listExperiments: QueryRef<Record<string, never>, ExperimentInfo[]>;
    getModelSummary: QueryRef<{ modelId: Id<"models"> }, ModelSummary>;
    getLatestRunTime: QueryRef<{ modelId: Id<"models"> }, number | null>;
    listRuns: QueryRef<
      { experiment?: string; modelId?: Id<"models">; limit?: number },
      RunWithCounts[]
    >;
    getRunDetails: QueryRef<{ runId: Id<"runs"> }, RunDetails | null>;
    getOutputUrl: QueryRef<{ storageId: Id<"_storage"> }, string | null>;
  };
};
