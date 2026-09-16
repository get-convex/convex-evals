#!/usr/bin/env bun
/** Standalone local smoke-pilot entrypoint. */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createJournal } from "./lib/clientWebTools";
import { runClientWebLoop as runClientWebPilot } from "../runner/models/clientWebLoop";
export { runClientWebPilot };

if (import.meta.main) {
  // No CLI path to Convex, scoring, deletion, or the production experiment.
  const [model, promptFile, outputDir] = process.argv.slice(2);
  if (!model || !promptFile || !outputDir)
    throw new Error(
      "Usage: bun scripts/clientWebPilot.ts MODEL PROMPT_FILE OUTPUT_DIR",
    );
  const openrouterKey = process.env.OPENROUTER_API_KEY ?? "";
  const exaKey = process.env.EXA_API_KEY ?? "";
  if (!openrouterKey || !exaKey)
    throw new Error("OPENROUTER_API_KEY and EXA_API_KEY are required");
  const journal = createJournal(join(outputDir, "events.jsonl"), [
    openrouterKey,
    exaKey,
  ]);
  const result = await runClientWebPilot({
    model,
    prompt: readFileSync(promptFile, "utf8"),
    openrouterKey,
    exaKey,
    journal,
  });
  console.log(JSON.stringify(result, null, 2));
}
