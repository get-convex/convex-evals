/* eslint-disable */

// Minimal Bun/TypeScript runner to execute a single eval locally without uploading to Braintrust.
// Hardcoded settings for simplicity. Edit here as needed.

import "dotenv/config";

const MODEL = "gpt-4.1";
const FILTER = "000-fundamentals/000-empty_functions";
const RESULTS_FILE = "local_results.jsonl";
const DISABLE_PROXY = true; // set to false if you want to use the Braintrust proxy

async function main() {
  const env = {
    ...process.env,
    TEST_FILTER: FILTER,
    MODELS: MODEL,
    BRAINTRUST_NO_SEND_LOGS: "1",
    BRAINTRUST_LOCAL_RESULTS: RESULTS_FILE,
    ...(DISABLE_PROXY ? { BRAINTRUST_DISABLE_PROXY: "1" } : {}),
  };

  // Ensure you set the correct provider API key in the environment before running, e.g.:
  //   OPENAI_API_KEY / ANTHROPIC_API_KEY / GOOGLE_API_KEY / XAI_API_KEY / TOGETHER_API_KEY

  const proc = Bun.spawn(
    ["pdm", "run", "python", "-m", "runner.eval_convex_coding"],
    {
      stdout: "inherit",
      stderr: "inherit",
      stdin: "inherit",
      env,
    },
  );

  const code = await proc.exited;
  if (typeof code === "number") process.exit(code);
  process.exit(0);
}

main().catch((err) => {
  console.error("Failed to run eval:", err);
  process.exit(1);
});
