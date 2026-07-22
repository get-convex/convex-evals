/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as admin from "../admin.js";
import type * as auth from "../auth.js";
import type * as benchmarkVersions from "../benchmarkVersions.js";
import type * as crons from "../crons.js";
import type * as debug from "../debug.js";
import type * as debugQueries from "../debugQueries.js";
import type * as evalAssets from "../evalAssets.js";
import type * as evals from "../evals.js";
import type * as historicalBenchmarks from "../historicalBenchmarks.js";
import type * as http from "../http.js";
import type * as migrations from "../migrations.js";
import type * as modelScores from "../modelScores.js";
import type * as models from "../models.js";
import type * as runMaintenance from "../runMaintenance.js";
import type * as runs from "../runs.js";
import type * as scoringUtils from "../scoringUtils.js";
import type * as steps from "../steps.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  admin: typeof admin;
  auth: typeof auth;
  benchmarkVersions: typeof benchmarkVersions;
  crons: typeof crons;
  debug: typeof debug;
  debugQueries: typeof debugQueries;
  evalAssets: typeof evalAssets;
  evals: typeof evals;
  historicalBenchmarks: typeof historicalBenchmarks;
  http: typeof http;
  migrations: typeof migrations;
  modelScores: typeof modelScores;
  models: typeof models;
  runMaintenance: typeof runMaintenance;
  runs: typeof runs;
  scoringUtils: typeof scoringUtils;
  steps: typeof steps;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  migrations: import("@convex-dev/migrations/_generated/component.js").ComponentApi<"migrations">;
};
