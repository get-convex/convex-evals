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
import type * as benchmarkKindMigration from "../benchmarkKindMigration.js";
import type * as benchmarkKinds from "../benchmarkKinds.js";
import type * as benchmarkVersions from "../benchmarkVersions.js";
import type * as crons from "../crons.js";
import type * as debug from "../debug.js";
import type * as debugQueries from "../debugQueries.js";
import type * as decisionAdmin from "../decisionAdmin.js";
import type * as decisionConfig from "../decisionConfig.js";
import type * as decisionIdentity from "../decisionIdentity.js";
import type * as decisionIngestionPerformance from "../decisionIngestionPerformance.js";
import type * as decisionScoring from "../decisionScoring.js";
import type * as decisionSourceValidation from "../decisionSourceValidation.js";
import type * as decisionStorage from "../decisionStorage.js";
import type * as decisionViews from "../decisionViews.js";
import type * as documentKinds from "../documentKinds.js";
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
import type * as webUsage from "../webUsage.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  admin: typeof admin;
  auth: typeof auth;
  benchmarkKindMigration: typeof benchmarkKindMigration;
  benchmarkKinds: typeof benchmarkKinds;
  benchmarkVersions: typeof benchmarkVersions;
  crons: typeof crons;
  debug: typeof debug;
  debugQueries: typeof debugQueries;
  decisionAdmin: typeof decisionAdmin;
  decisionConfig: typeof decisionConfig;
  decisionIdentity: typeof decisionIdentity;
  decisionIngestionPerformance: typeof decisionIngestionPerformance;
  decisionScoring: typeof decisionScoring;
  decisionSourceValidation: typeof decisionSourceValidation;
  decisionStorage: typeof decisionStorage;
  decisionViews: typeof decisionViews;
  documentKinds: typeof documentKinds;
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
  webUsage: typeof webUsage;
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
