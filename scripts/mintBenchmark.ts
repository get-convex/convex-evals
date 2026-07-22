#!/usr/bin/env bun
import "dotenv/config";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../evalScores/convex/_generated/api.js";
import {
  computeBenchmarkDefinition,
  discoverBenchmarkEvalPaths,
} from "../runner/benchmark.js";
import { ALL_MODELS } from "../runner/models/index.js";

async function main(): Promise<void> {
  const convexUrl = process.env.CONVEX_EVAL_URL;
  const token = process.env.CONVEX_AUTH_TOKEN;
  if (!convexUrl || !token) {
    throw new Error("CONVEX_EVAL_URL and CONVEX_AUTH_TOKEN are required");
  }

  const definition = computeBenchmarkDefinition(discoverBenchmarkEvalPaths());
  const client = new ConvexHttpClient(convexUrl);
  await client.mutation(api.admin.mintBenchmark, {
    token,
    version: definition.version,
    evalCount: definition.evalCount,
    curatedModels: ALL_MODELS,
  });

  console.log(
    `Minted benchmark ${definition.version.slice(0, 12)} (${definition.evalCount} evals, ${ALL_MODELS.length} curated models)`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
