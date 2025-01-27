# Convex Coding Evals

LLMs don't have _perfect_ knowledge of Convex, so they require some prompting
to help them along. This repo contains a set of prompts for coding a Convex
backend, a set of human-curated solutions, and a script for evaluating the
LLM's output.

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
TEST_FILTER='data_modeling' pdm run braintrust run runner/eval_convex_coding.py
```

The test will also print out what temporary directory it's using for storing the generated files. You can override this
with the `OUTPUT_TEMPDIR` environment variable.

```bash
OUTPUT_TEMPDIR=/tmp/convex-codegen-evals pdm run braintrust run runner/eval_convex_coding.py
```

## Rerunning grading

After running the evals, you may want to dig into a particular test failure. You can use the `run_grader.py` script to grade the evaluations again without regenerating them:

```bash
pdm run python runner/run_grader.py /tmp/convex-codegen-evals
```

You can also pass in a path to a specific evaluation.

```bash
pdm run python runner/run_grader.py /tmp/convex-codegen-evals/output/claude-3-5-sonnet-latest/000-fundamentals/000-http_actions_file_storage
```

## Adding a new evaluation

Use the `create_eval.py` script to create a new evaluation.

```bash
pdm run python runner/create_eval.py <category> <name>
```

Note that test or category names cannot contain dashes.

Then, fill out the `TASK.txt` and the human-curated answer within the `answer`
directory. Fill out unit tests within the `grader.test.ts` file.

Be sure that your answer passes tests:

```bash
pdm run runner/run_grader.py evals/<category>/<name>/answer
```

# Outstanding Evals

- [ordering](https://docs.convex.dev/database/reading-data#ordering)
