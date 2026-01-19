#!/usr/bin/env bun
/**
 * Interactive CLI for running Convex evals.
 * Run with: bun run scripts/runEvals.ts
 * Or use: bun run evals (after adding to package.json)
 */

import { Command } from "commander";
import { select, checkbox, confirm, input } from "@inquirer/prompts";
import { readdir, readFile, stat } from "fs/promises";
import { join } from "path";
import { spawn } from "child_process";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface EvalResult {
  category: string;
  name: string;
  passed: boolean;
  tests_pass_score: number;
  failure_reason: string | null;
  directory_path: string;
}

interface RunResult {
  model_name: string;
  tempdir: string;
  individual_results: EvalResult[];
  run_stats: {
    total_tests: number;
    total_passed: number;
    total_failed: number;
    overall_score: number;
  };
}

interface CategoryInfo {
  name: string;
  displayName: string;
  evals: EvalInfo[];
}

interface EvalInfo {
  name: string;
  fullPath: string;
  category: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const EVALS_DIR = "evals";
const LOCAL_RESULTS_FILE = "local_results.jsonl";
const MODELS_FILE = "runner/models/__init__.py";
const DEFAULT_MODEL = "claude-sonnet-4-5";

interface ModelChoice {
  name: string;
  value: string;
  provider: string;
}

/**
 * Parses the Python models file to extract available models.
 * This keeps the CLI in sync with the Python runner without duplication.
 */
async function discoverModels(): Promise<ModelChoice[]> {
  try {
    const content = await readFile(MODELS_FILE, "utf-8");

    const models: ModelChoice[] = [];

    // Match ModelTemplate entries - the format spans multiple lines
    // We match each ModelTemplate block and extract the fields
    const modelBlockRegex =
      /ModelTemplate\([\s\S]*?provider=ModelProvider\.(\w+)[\s\S]*?\),/g;

    let blockMatch;
    while ((blockMatch = modelBlockRegex.exec(content)) !== null) {
      const block = blockMatch[0];
      const provider = blockMatch[1];

      // Extract name and formatted_name from the block
      const nameMatch = block.match(/name="([^"]+)"/);
      const formattedNameMatch = block.match(/formatted_name="([^"]+)"/);

      if (nameMatch && formattedNameMatch) {
        models.push({
          name: formattedNameMatch[1],
          value: nameMatch[1],
          provider: provider.toLowerCase(),
        });
      }
    }

    return models;
  } catch (error) {
    console.error("Warning: Could not read models from Python file:", error);
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Converts a directory name like "001-data_modeling" to "Data Modeling"
 * Strips leading number prefix and converts underscores to spaces with title case
 */
function formatDisplayName(dirName: string): string {
  // Remove leading number prefix (e.g., "001-" or "000-")
  const withoutPrefix = dirName.replace(/^\d+-/, "");
  // Replace underscores with spaces and convert to title case
  return withoutPrefix
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

/**
 * Converts a provider enum value like "anthropic" to "Anthropic"
 */
function formatProviderName(provider: string): string {
  const providerNames: Record<string, string> = {
    anthropic: "Anthropic",
    openai: "OpenAI",
    together: "Together",
    google: "Google",
    xai: "xAI",
  };
  return providerNames[provider] ?? provider;
}

// ─────────────────────────────────────────────────────────────────────────────
// Discovery Functions
// ─────────────────────────────────────────────────────────────────────────────

async function discoverCategories(): Promise<CategoryInfo[]> {
  const categories: CategoryInfo[] = [];
  const entries = await readdir(EVALS_DIR, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const categoryPath = join(EVALS_DIR, entry.name);
    const evals = await discoverEvalsInCategory(entry.name, categoryPath);

    categories.push({
      name: entry.name,
      displayName: formatDisplayName(entry.name),
      evals,
    });
  }

  categories.sort((a, b) => a.name.localeCompare(b.name));
  return categories;
}

async function discoverEvalsInCategory(
  categoryName: string,
  categoryPath: string,
): Promise<EvalInfo[]> {
  const evals: EvalInfo[] = [];
  const entries = await readdir(categoryPath, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const evalPath = join(categoryPath, entry.name);
    const taskFile = join(evalPath, "TASK.txt");

    try {
      await stat(taskFile);
      evals.push({
        name: entry.name,
        fullPath: `${categoryName}/${entry.name}`,
        category: categoryName,
      });
    } catch {
      // No TASK.txt, skip
    }
  }

  evals.sort((a, b) => a.name.localeCompare(b.name));
  return evals;
}

// ─────────────────────────────────────────────────────────────────────────────
// Results Parsing
// ─────────────────────────────────────────────────────────────────────────────

async function getLastRunResults(): Promise<RunResult | null> {
  try {
    const content = await readFile(LOCAL_RESULTS_FILE, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    if (lines.length === 0) return null;

    const lastLine = lines[lines.length - 1];
    return JSON.parse(lastLine) as RunResult;
  } catch {
    return null;
  }
}

async function getFailedEvals(): Promise<string[]> {
  const lastRun = await getLastRunResults();
  if (!lastRun) return [];

  return lastRun.individual_results
    .filter((r) => !r.passed)
    .map((r) => `${r.category}/${r.name}`);
}

async function getLastRunSummary(): Promise<string | null> {
  const lastRun = await getLastRunResults();
  if (!lastRun) return null;

  const { run_stats, model_name } = lastRun;
  const passRate = (run_stats.overall_score * 100).toFixed(1);
  return `${model_name}: ${run_stats.total_passed}/${run_stats.total_tests} passed (${passRate}%)`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Run Execution
// ─────────────────────────────────────────────────────────────────────────────

interface RunOptions {
  models: string[];
  filter?: string;
  disableBraintrust: boolean;
  verbose: boolean;
  outputTempdir?: string;
  postToConvex: boolean;
}

function isConvexPostingConfigured(): boolean {
  return Boolean(process.env.CONVEX_EVAL_ENDPOINT && process.env.CONVEX_AUTH_TOKEN);
}

function buildEnvVars(options: RunOptions): Record<string, string> {
  const env: Record<string, string> = { ...process.env } as Record<
    string,
    string
  >;

  if (options.models.length > 0) {
    env.MODELS = options.models.join(",");
  }

  if (options.filter) {
    env.TEST_FILTER = options.filter;
  }

  if (options.disableBraintrust) {
    env.DISABLE_BRAINTRUST = "1";
  }

  if (options.verbose) {
    env.VERBOSE_INFO_LOGS = "1";
  }

  if (options.postToConvex) {
    env.POST_TO_CONVEX = "1";
  }

  env.LOCAL_RESULTS = LOCAL_RESULTS_FILE;

  if (options.outputTempdir) {
    env.OUTPUT_TEMPDIR = options.outputTempdir;
  }

  return env;
}

async function runEvals(options: RunOptions): Promise<void> {
  const env = buildEnvVars(options);

  console.log(
    "\n┌─────────────────────────────────────────────────────────────┐",
  );
  console.log(
    "│                    Running Convex Evals                     │",
  );
  console.log(
    "└─────────────────────────────────────────────────────────────┘\n",
  );

  console.log("Configuration:");
  console.log(`  Models: ${options.models.join(", ") || "(default)"}`);
  console.log(`  Filter: ${options.filter || "(all)"}`);
  console.log(
    `  Braintrust: ${options.disableBraintrust ? "disabled" : "enabled"}`,
  );
  console.log(
    `  Post to Convex: ${options.postToConvex ? "yes" : "no"}${options.postToConvex && !isConvexPostingConfigured() ? " (⚠️  CONVEX_EVAL_ENDPOINT or CONVEX_AUTH_TOKEN not set)" : ""}`,
  );
  console.log(`  Verbose: ${options.verbose ? "yes" : "no"}`);
  console.log("");

  const child = spawn(
    "pdm",
    ["run", "python", "-m", "runner.eval_convex_coding"],
    {
      env,
      stdio: "inherit",
      shell: true,
    },
  );

  return new Promise((resolve, reject) => {
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Eval run exited with code ${code}`));
      }
    });
    child.on("error", reject);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Interactive Mode
// ─────────────────────────────────────────────────────────────────────────────

const BACK = Symbol("back");

type SelectResult<T> = T | typeof BACK;

async function selectFilter(
  categories: CategoryInfo[],
  failedEvals: string[],
): Promise<SelectResult<string | undefined>> {
  const action = await select({
    message: "What would you like to run?",
    choices: [
      { name: "Run all evals", value: "all" },
      { name: "Select categories to run", value: "categories" },
      { name: "Select specific evals", value: "evals" },
      ...(failedEvals.length > 0
        ? [
            {
              name: `Re-run last failed (${failedEvals.length} evals)`,
              value: "failed",
            },
          ]
        : []),
      { name: "Run single eval by path", value: "single" },
      { name: "← Back", value: "back" },
    ],
  });

  if (action === "back") return BACK;

  if (action === "all") return undefined;

  if (action === "categories") {
    const selectedCategories = await checkbox({
      message: "Select categories to run (space to toggle, enter to confirm):",
      choices: categories.map((c) => ({
        name: `${c.displayName} (${c.evals.length} evals)`,
        value: c.name,
      })),
    });

    if (selectedCategories.length === 0) return BACK;
    return selectedCategories.join("|");
  }

  if (action === "evals") {
    const allEvals = categories.flatMap((c) =>
      c.evals.map((e) => ({
        name: `[${c.displayName}] ${e.name}`,
        value: e.fullPath,
      })),
    );

    const selectedEvals = await checkbox({
      message: "Select evals to run (space to toggle, enter to confirm):",
      choices: allEvals,
      pageSize: 20,
    });

    if (selectedEvals.length === 0) return BACK;
    return selectedEvals.join("|");
  }

  if (action === "failed") {
    if (failedEvals.length === 0) return BACK;
    console.log(`\nRe-running ${failedEvals.length} failed evals:`);
    failedEvals.forEach((e) => console.log(`  - ${e}`));
    return failedEvals.join("|");
  }

  if (action === "single") {
    const evalPath = await input({
      message: "Enter eval path (e.g., 000-fundamentals/000-empty_functions):",
    });

    if (!evalPath.trim()) return BACK;
    return evalPath.trim();
  }

  return BACK;
}

async function selectModels(): Promise<SelectResult<string[]>> {
  const modelChoice = await select({
    message: "Select model(s):",
    choices: [
      { name: "Claude 4.5 Sonnet (default)", value: DEFAULT_MODEL },
      { name: "Choose from list", value: "choose" },
      { name: "Enter custom model name(s)", value: "custom" },
      { name: "← Back", value: "back" },
    ],
  });

  if (modelChoice === "back") return BACK;

  if (modelChoice === "choose") {
    const availableModels = await discoverModels();
    const selected = await checkbox({
      message: "Select models (space to toggle, enter to confirm):",
      choices: availableModels.map((m) => ({ name: m.name, value: m.value })),
      pageSize: 15,
    });

    if (selected.length === 0) return BACK;
    return selected;
  }

  if (modelChoice === "custom") {
    const customModels = await input({
      message: "Enter model name(s) (comma-separated):",
    });
    const models = customModels
      .split(",")
      .map((m) => m.trim())
      .filter(Boolean);

    if (models.length === 0) return BACK;
    return models;
  }

  return [modelChoice];
}

async function selectOptions(): Promise<
  SelectResult<{ useBraintrust: boolean; verbose: boolean; postToConvex: boolean }>
> {
  const useBraintrust = await confirm({
    message: "Send results to Braintrust?",
    default: false,
  });

  // Only ask about Convex posting if the env vars are configured
  let postToConvex = false;
  if (isConvexPostingConfigured()) {
    postToConvex = await confirm({
      message: "Post results to Convex database?",
      default: false,
    });
  }

  const verbose = await confirm({
    message: "Enable verbose logging?",
    default: true,
  });

  return { useBraintrust, verbose, postToConvex };
}

interface LastRunConfig {
  models: string[];
  filter: string | undefined;
  useBraintrust: boolean;
  verbose: boolean;
  postToConvex: boolean;
}

function formatRunConfigSummary(config: LastRunConfig): string {
  const parts: string[] = [];
  parts.push(`Models: ${config.models.join(", ") || "(default)"}`);
  parts.push(`Filter: ${config.filter || "(all)"}`);
  return parts.join(", ");
}

async function interactiveMode(): Promise<void> {
  console.log("\n🧪 Convex Evals Runner\n");

  const lastRunSummary = await getLastRunSummary();
  if (lastRunSummary) {
    console.log(`Last run: ${lastRunSummary}\n`);
  }

  const categories = await discoverCategories();
  let failedEvals = await getFailedEvals();
  let lastRunConfig: LastRunConfig | null = null;

  // Main loop with back navigation
  while (true) {
    // Build menu choices dynamically based on whether we have a previous run config
    const menuChoices = [
      { name: "Run evals", value: "run" },
      ...(lastRunConfig
        ? [{ name: "Run again", value: "run-again" }]
        : []),
      { name: "View status", value: "status" },
      { name: "List available evals", value: "list" },
      { name: "Exit", value: "exit" },
    ];

    const mainAction = await select({
      message: "What would you like to do?",
      choices: menuChoices,
    });

    if (mainAction === "exit") {
      console.log("Goodbye! 👋\n");
      return;
    }

    if (mainAction === "status") {
      const lastRun = await getLastRunResults();
      if (!lastRun) {
        console.log("\nNo previous run results found.\n");
        continue;
      }

      const { run_stats, model_name, individual_results } = lastRun;
      console.log(`\nModel: ${model_name}`);
      console.log(`Score: ${(run_stats.overall_score * 100).toFixed(1)}%`);
      console.log(
        `Passed: ${run_stats.total_passed}/${run_stats.total_tests}\n`,
      );

      for (const result of individual_results) {
        const status = result.passed ? "✅" : "❌";
        const score = (result.tests_pass_score * 100).toFixed(0);
        const reason = result.failure_reason
          ? ` (${result.failure_reason})`
          : "";
        console.log(
          `  ${status} ${result.category}/${result.name} - ${score}%${reason}`,
        );
      }
      console.log("");
      continue;
    }

    if (mainAction === "list") {
      console.log("\n📋 Available Evals\n");
      for (const category of categories) {
        console.log(`${category.displayName} (${category.name})`);
        for (const evalInfo of category.evals) {
          console.log(`  └─ ${evalInfo.name}`);
        }
        console.log("");
      }
      continue;
    }

    if (mainAction === "run-again" && lastRunConfig) {
      const runAgainChoice = await select({
        message: "Run again:",
        choices: [
          {
            name: `With same values (${formatRunConfigSummary(lastRunConfig)})`,
            value: "same",
          },
          { name: "Change values", value: "change" },
          { name: "← Back", value: "back" },
        ],
      });

      if (runAgainChoice === "back") continue;

      if (runAgainChoice === "same") {
        try {
          await runEvals({
            models: lastRunConfig.models,
            filter: lastRunConfig.filter,
            disableBraintrust: !lastRunConfig.useBraintrust,
            verbose: lastRunConfig.verbose,
            postToConvex: lastRunConfig.postToConvex,
          });
          // Refresh failed evals after run
          failedEvals = await getFailedEvals();
        } catch (error) {
          console.error("\nEval run failed:", error);
        }
        continue;
      }

      // runAgainChoice === "change" - fall through to run flow but with pre-filled defaults
    }

    // Run evals flow with back navigation
    const filter = await selectFilter(categories, failedEvals);
    if (filter === BACK) continue;

    const models = await selectModels();
    if (models === BACK) continue;

    const options = await selectOptions();
    if (options === BACK) continue;

    // Confirm and run
    const shouldRun = await confirm({
      message: "Ready to run. Proceed?",
      default: true,
    });

    if (!shouldRun) {
      console.log("Cancelled.\n");
      continue;
    }

    // Save the run config for "Run again" option
    lastRunConfig = {
      models,
      filter,
      useBraintrust: options.useBraintrust,
      verbose: options.verbose,
      postToConvex: options.postToConvex,
    };

    try {
      await runEvals({
        models,
        filter,
        disableBraintrust: !options.useBraintrust,
        verbose: options.verbose,
        postToConvex: options.postToConvex,
      });
      // Refresh failed evals after run
      failedEvals = await getFailedEvals();
    } catch (error) {
      console.error("\nEval run failed:", error);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI Setup
// ─────────────────────────────────────────────────────────────────────────────

const program = new Command();

program
  .name("evals")
  .description("Interactive CLI for running Convex evals")
  .version("1.0.0");

program
  .command("run", { isDefault: true })
  .description("Run evals (interactive mode if no options provided)")
  .option("-m, --model <models...>", "Model(s) to use")
  .option("-f, --filter <pattern>", "Filter evals by regex pattern")
  .option("-c, --category <categories...>", "Run specific categories")
  .option("--failed", "Re-run only failed evals from last run")
  .option("--braintrust", "Send results to Braintrust")
  .option("--post-to-convex", "Post results to Convex database")
  .option("-v, --verbose", "Enable verbose logging", true)
  .option("--no-verbose", "Disable verbose logging")
  .option("-o, --output <dir>", "Output directory for results")
  .action(async (options) => {
    // If no filtering options provided, enter interactive mode
    const hasFilterOptions =
      options.model || options.filter || options.category || options.failed;

    if (!hasFilterOptions) {
      await interactiveMode();
      return;
    }

    // Build filter from options
    let filter: string | undefined = options.filter;

    if (options.category) {
      filter = options.category.join("|");
    }

    if (options.failed) {
      const failedEvals = await getFailedEvals();
      if (failedEvals.length === 0) {
        console.log("No failed evals to re-run.");
        return;
      }
      filter = failedEvals.join("|");
      console.log(`Re-running ${failedEvals.length} failed evals`);
    }

    await runEvals({
      models: options.model || [],
      filter,
      disableBraintrust: !options.braintrust,
      verbose: options.verbose,
      outputTempdir: options.output,
      postToConvex: options.postToConvex || false,
    });
  });

program
  .command("list")
  .description("List available evals")
  .option("-c, --category <category>", "Filter by category")
  .action(async (options) => {
    const categories = await discoverCategories();

    console.log("\n📋 Available Evals\n");

    for (const category of categories) {
      if (options.category && category.name !== options.category) continue;

      console.log(`${category.displayName} (${category.name})`);
      for (const evalInfo of category.evals) {
        console.log(`  └─ ${evalInfo.name}`);
      }
      console.log("");
    }

    const totalEvals = categories.reduce((sum, c) => sum + c.evals.length, 0);
    console.log(
      `Total: ${totalEvals} evals in ${categories.length} categories\n`,
    );
  });

program
  .command("status")
  .description("Show last run results")
  .option("--failed", "Show only failed evals")
  .action(async (options) => {
    const lastRun = await getLastRunResults();

    if (!lastRun) {
      console.log("\nNo previous run results found.\n");
      return;
    }

    const { run_stats, model_name, individual_results, tempdir } = lastRun;

    console.log("\n📊 Last Run Status\n");
    console.log(`Model: ${model_name}`);
    console.log(`Output: ${tempdir}`);
    console.log(`Score: ${(run_stats.overall_score * 100).toFixed(1)}%`);
    console.log(`Passed: ${run_stats.total_passed}/${run_stats.total_tests}`);
    console.log("");

    const resultsToShow = options.failed
      ? individual_results.filter((r) => !r.passed)
      : individual_results;

    if (options.failed && resultsToShow.length === 0) {
      console.log("All evals passed! 🎉\n");
      return;
    }

    console.log(options.failed ? "Failed Evals:" : "Results:");
    for (const result of resultsToShow) {
      const status = result.passed ? "✅" : "❌";
      const score = (result.tests_pass_score * 100).toFixed(0);
      const reason = result.failure_reason ? ` (${result.failure_reason})` : "";
      console.log(
        `  ${status} ${result.category}/${result.name} - ${score}%${reason}`,
      );
    }
    console.log("");
  });

program
  .command("models")
  .description("List available models")
  .action(async () => {
    const availableModels = await discoverModels();

    console.log("\n🤖 Available Models\n");

    // Group by provider (from the parsed Python data)
    const byProvider: Record<string, ModelChoice[]> = {};
    for (const model of availableModels) {
      const providerName = formatProviderName(model.provider);
      byProvider[providerName] = byProvider[providerName] || [];
      byProvider[providerName].push(model);
    }

    for (const [provider, models] of Object.entries(byProvider)) {
      console.log(`${provider}:`);
      for (const model of models) {
        console.log(`  └─ ${model.name} (${model.value})`);
      }
      console.log("");
    }
  });

program.parse();
