# Convex Coding Evals

Convex is an open-source, reactive database that's the best platform for full-stack AI coding.

We ensure that Convex performs well with a large set of models by continuously running evals. Each eval has a set prompts for coding a Convex backend, a set of human-curated solutions, and a script for evaluating the LLM's output. These evals are split up into seven different categories:

- Fundamentals
- Data Modeling
- Queries
- Mutations
- Actions
- Idioms
- Clients

The most up to date eval runs can be found on our [website](https://convex.dev/llm-leaderboard).

We use these evals to tune our [Convex Guidelines](https://docs.convex.dev/ai/), which greatly improve model performance writing Convex code and decrease hallucinations.

## Running the evaluations

First, install dependencies:

```bash
pip install pdm
pdm install

npm install -g bun
bun install

echo "ANTHROPIC_API_KEY=<your ANTHROPIC_API_KEY>" > .env
echo "OPENAI_API_KEY=<your OPENAI_API_KEY>" >> .env
```

### Using the CLI (recommended)

The easiest way to run evals is with the interactive CLI:

```bash
bun run evals
```

<video src="docs/assets/cli.mp4" controls width="100%"></video>

This launches an interactive menu where you can:

- Run all evals
- Select specific categories to run
- Select individual evals
- Re-run failed evals from your last run
- Choose which model(s) to use

#### CLI Commands

| Command                         | Description                            |
| ------------------------------- | -------------------------------------- |
| `bun run evals`                 | Interactive mode                       |
| `bun run evals list`            | List all available evals by category   |
| `bun run evals status`          | Show results from last run             |
| `bun run evals status --failed` | Show only failed evals                 |
| `bun run evals models`          | List available models                  |
| `bun run evals:failed`          | Re-run only failed evals from last run |

#### CLI Options

Run evals directly without interactive mode:

```bash
# Run specific categories
bun run evals run -c 000-fundamentals 002-queries

# Run with a specific model
bun run evals run -m claude-sonnet-4-5 -c 005-idioms

# Run with multiple models
bun run evals run -m claude-sonnet-4-5 -m gpt-5 -f "000-fundamentals"

# Re-run failed evals
bun run evals run --failed

# Filter by regex pattern
bun run evals run -f "pagination"

# Send results to Braintrust
bun run evals run --braintrust -c 000-fundamentals
```

### Using Braintrust directly

Get a Braintrust API key from [the dashboard](https://www.braintrust.dev/app/Convex/settings/api-keys).
You can run the `eval_convex_coding.py` evals with the `braintrust` CLI:

```bash
BRAINTRUST_API_KEY=<your BRAINTRUST_API_KEY> pdm run braintrust eval runner/eval_convex_coding.py
```

It'll print out a URL for viewing the report online. You can specify a test filter regex via an environment variable:

```bash
TEST_FILTER='data_modeling' pdm run braintrust eval runner/eval_convex_coding.py
```

The test will also print out what temporary directory it's using for storing the generated files. You can override this
with the `OUTPUT_TEMPDIR` environment variable.

```bash
OUTPUT_TEMPDIR=/tmp/convex-codegen-evals pdm run braintrust eval runner/eval_convex_coding.py
```

### Environment variables

| Variable               | Description                             |
| ---------------------- | --------------------------------------- |
| `MODELS`               | Comma-separated list of models to run   |
| `TEST_FILTER`          | Regex pattern to filter evals           |
| `DISABLE_BRAINTRUST`   | Set to `1` to disable Braintrust upload |
| `VERBOSE_INFO_LOGS`    | Set to `1` for verbose logging          |
| `LOCAL_RESULTS`        | Path to write local results JSONL file  |
| `OUTPUT_TEMPDIR`       | Directory for generated output files    |
| `CONVEX_EVAL_ENDPOINT` | Endpoint for Convex summary posting     |
| `CONVEX_AUTH_TOKEN`    | Auth token for Convex summary posting   |

### Output

- Per-step progress lines with the eval id
- Per-eval result with ✅/❌ and a clickable output dir
- `local_results.jsonl` with detailed results (used by `bun run evals status`)

## AI grading helper

Grader tests can include an AI-based assessment that provides concise reasoning on failure. See the "AI grading" section in `EVAL_WORKFLOW.md` for details and usage with `createAIGraderTest(import.meta.url)`.

## Rerunning grading

After running the evals, you may want to dig into a particular test failure. You can use the `run_grader.py` script to grade the evaluations again without regenerating them:

```bash
pdm run python -m runner.run_grader /tmp/convex-codegen-evals
```

You can also pass in a path to a specific evaluation.

```bash
pdm run python -m runner.run_grader /tmp/convex-codegen-evals/output/claude-3-5-sonnet-latest/000-fundamentals/000-http_actions_file_storage
```

## Adding a new evaluation

Use the `create_eval.py` script to create a new evaluation.

```bash
pdm run python -m runner.create_eval <category> <name>
```

Note that test or category names cannot contain dashes.

It will walk you through things step by step. You can start at a given step by passing a 3rd argument of the step number to start from.
At each step, it will generate some content and have you edit it.
It will generally open the files to review automatically with `cursor`,
meaning you should have that utility installed in your shell.

1. Generates a `TASK.txt` file for what the LLM should do.
2. Generates an `answer/` directory with the human-curated answer.
3. Generates a `grader.test.ts` file with unit tests.
4. Interactively runs the backend and tests
5. Runs the eval with braintrust. At this point edit `GAPS.txt` to capture what needs improvement.
6. Commits it to git.

Be sure that your answer passes tests:

```bash
pdm run python -m runner.run_grader evals/<category>/<name>/answer
```

# Generating guidelines

```bash
pdm run python -m runner.models.guidelines <outdir>
```

This will generate guidelines for Anthropic and OpenAI in the specified directory.

# Outstanding Evals

- [ordering](https://docs.convex.dev/database/reading-data#ordering)
