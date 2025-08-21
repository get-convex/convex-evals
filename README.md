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

Then, get a Braintrust API key from [the dashboard](https://www.braintrust.dev/app/Convex/settings/api-keys).
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

## Running locally (no Braintrust upload)

Run a small slice without uploading. Put the provider API key you need in `.env` (e.g. `OPENAI_API_KEY`).

Scripts:

```bash
# Quick smoke test (first Fundamental)
npm run local:run:one

# Full Fundamentals category
npm run local:run:fundamentals

# Baseline local run (override TEST_FILTER as needed)
npm run local:run
```

These set:

- `DISABLE_BRAINTRUST=1` (disables Braintrust upload and proxy)
- `MODELS=gpt-4.1` (change per `runner/models/__init__.py`)
- `LOCAL_RESULTS=local_results.jsonl`

Output:

- Per-step progress lines with the eval id
- Per-eval result with ✅/❌ and a clickable output dir
- `local_results.jsonl` plus a `run.log` in each eval’s output directory

Optional Convex summary posting (still local mode): set both `CONVEX_EVAL_ENDPOINT` and `CONVEX_AUTH_TOKEN`.

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
