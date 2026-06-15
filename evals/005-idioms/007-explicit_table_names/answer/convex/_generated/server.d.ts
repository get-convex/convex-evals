/* eslint-disable */
/**
 * Generated utilities for implementing server-side Convex query and mutation functions.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import {
  ActionBuilder,
  HttpActionBuilder,
  MutationBuilder,
  QueryBuilder,
} from "convex/server";
import type { DataModel } from "./dataModel.js";

/**
 * Define a query in this Convex app's public API.
 */
export declare const query: QueryBuilder<DataModel, "public">;

/**
 * Define a mutation in this Convex app's public API.
 */
export declare const mutation: MutationBuilder<DataModel, "public">;

/**
 * Define an action in this Convex app's public API.
 */
export declare const action: ActionBuilder<DataModel, "public">;

/**
 * Define an HTTP action.
 */
export declare const httpAction: HttpActionBuilder;
