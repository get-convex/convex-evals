# Convex Coding Evals

LLMs don't have _perfect_ knowledge of Convex, so they require some prompting
to help them along. This repo contains a set of prompts for coding a Convex
backend, a set of human-curated solutions, and a script for evaluating the
LLM's output.

## Running the evaluations

```
pip install pdm
pdm install

npm install -g bun
bun install

echo "ANTHROPIC_API_KEY=<your ANTHROPIC_API_KEY>" > .env
echo "OPENAI_API_KEY=<your OPENAI_API_KEY>" >> .env

pdm run python runner/main.py --model=claude-3-5-sonnet-latest
```

If you'd like to grade the evaluations again without regenerating them, run:

```
pdm run python runner/main.py --skip-generation
```

Grading writes out a JSON report in the output directory.

You can also pretty print the report:

```
pdm run python runner/main.py --output-dir=output
pdm run python print_report.py output/report.json
```

## Creating a new evaluation

```
pdm run python create_eval.py <name> <category>
```

For example, adding a new fundmentals eval for using HTTP actions and storage would be:

```
pdm run python create_eval.py http_actions_file_storage 000-fundamentals
```

Note that test or category names cannot contain dashes.
