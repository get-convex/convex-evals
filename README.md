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

You can run the evals locally without uploading anything to Braintrust. This flow writes a JSONL results file and prints a concise summary to the console.

Prerequisites:

- Put your provider API key(s) in `.env` (loaded automatically):
  - `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, `XAI_API_KEY`, or `TOGETHER_API_KEY`

Helper scripts:

```bash
# Run a very small slice (fast): first Fundamental
npm run local:run:one

# Run the full Fundamentals category (still local-only)
npm run local:run:fundamentals

# Generic local run baseline (you can override TEST_FILTER manually)
npm run local:run
```

What these scripts do:

- `local:run:one` sets `TEST_FILTER=000-fundamentals/000` (quickest smoke test)
- `local:run:fundamentals` sets `TEST_FILTER=000-fundamentals`
- All `local:run*` scripts set:
  - `MODELS=gpt-4.1` (change to any supported model from `runner/models/__init__.py`)
  - `BRAINTRUST_NO_SEND_LOGS=1` (disables Braintrust uploads)
  - `BRAINTRUST_LOCAL_RESULTS=local_results.jsonl` (results file path)
  - `BRAINTRUST_DISABLE_PROXY=1` (model calls go directly to the provider)
- They ultimately run `npm run run:evals` → `pdm run python -m runner.eval_convex_coding`.

What you'll see:

- Live step logs prefixed with `[eval]` (install, codegen, tsc, eslint, deploy, tests)
- Per-eval status lines with ✅/❌ and a clickable absolute path to the generated project dir
- A pretty summary block at the end showing overall and per-category pass rates
- A JSONL file at `local_results.jsonl` (or your chosen path)

Optional: post results to your Convex app

- Set both env vars to enable posting an aggregate score JSON to your Convex function:
  - `CONVEX_EVAL_ENDPOINT` – your HTTP function URL
  - `CONVEX_AUTH_TOKEN` – bearer token included as `Authorization: Bearer <token>`
- If either is missing, Convex posting is skipped automatically.

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
