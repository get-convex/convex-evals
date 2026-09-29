---
name: validate-guidelines
description: Empirically verify guideline changes by running before/after eval runs across multiple models and ensuring no regressions. Use when proposing or reviewing changes to runner/models/guidelines.md, or when the user asks to validate guidelines.
---

# Validate Guidelines

## When to use

- User proposes or has made changes to `runner/models/guidelines.md` and wants to ensure they don't regress other models
- User says "validate the guideline changes" or "run the guideline validation"
- Before committing guideline edits, to confirm improvements or no-regression across the default models (or a subset)

## Overview

Guideline changes are validated by running evals twice per model: once with the **current** (before) guidelines and once with the **proposed** (after) guidelines. Results are compared; any eval that passed before and fails after is a regression. The goal is to ensure changes improve or at least do not regress scores across multiple models.

## Step 1: Identify the change

Determine which sections of `runner/models/guidelines.md` were modified (its `##` headings, e.g. `## Function guidelines`, `## Query guidelines`, `## File storage guidelines`) and the intent (new rule, clarification, token compaction). `runner/models/guidelines.md` is the source. `runner/models/guidelines.ts` only loads it.

## Step 2: Build before and after guideline files

Do what the Validate Guideline Changes workflow (`.github/workflows/validate_guidelines.yml`) does. Write both files to a temp directory outside the repo:

- **Before**: the committed guidelines on main.
  ```bash
  git fetch origin
  git show origin/main:runner/models/guidelines.md > <tmp>/before.md
  ```
- **After**: apply the proposed edits to `runner/models/guidelines.md`, then `cp runner/models/guidelines.md <tmp>/after.md`.

The script sends each file as-is as the guidelines. Ensure both paths are absolute or relative to the repo root and that the script can read them.

## Step 3: Select target evals

Choose a `--filter` regex on eval `category/name` from this list, or omit it for the full suite:

- `## Function guidelines` (http, validators, registration, calling, pagination): `000-fundamentals|006-clients`, or full
- `## Schema guidelines`: `001-data_modeling`
- `## Authentication guidelines`: `005-idioms/003|005-idioms/004`
- `## Typescript guidelines`: omit (run all)
- `## Full text search guidelines`: `002-queries/009|002-queries/020`
- `## Vector search guidelines`: `004-actions/008`
- `## Component guidelines`: `007-components`
- `## Query guidelines`: `002-queries`
- `## Mutation guidelines`: `003-mutations`
- `## Action guidelines`: `004-actions`
- `## Scheduling guidelines`: `000-fundamentals/003|000-fundamentals/004`
- `## Testing guidelines`: `005-idioms/005`
- `## File storage guidelines`: `000-fundamentals/007|004-actions/004|004-actions/005`

- **Targeted change** (e.g. one section): use a filter that matches the evals most likely affected.
- **Broad change** (e.g. wording across many sections): omit `--filter` to run all evals.

## Step 4: Select models

Default set (preferred for validation, and the workflow's default): `anthropic/claude-sonnet-5`, `anthropic/claude-opus-4.8`, `deepseek/deepseek-v4-pro`, `openai/gpt-5.5`. Each model must be a full OpenRouter slug in `ALL_MODELS` (`runner/models/index.ts`). The script exits if one isn't.

Every model runs through OpenRouter, so the script needs only `OPENROUTER_API_KEY` in the root `.env`. Without it the script skips every model and still prints "Safe to commit", so check that the summary has a row per model. Use a subset to cut cost; at least two models are recommended.

## Step 5: Estimate the cost and get approval

Each model runs the selected evals twice, before and after, in the default condition. A run without `--filter` is 2 full suites per model. Take each model's average full-suite cost from the public production query `modelScores:getSchedulingStats`, as in the add-model skill:

```bash
URL=https://fabulous-panther-525.convex.cloud
for slug in anthropic/claude-sonnet-5 anthropic/claude-opus-4.8 deepseek/deepseek-v4-pro openai/gpt-5.5; do
  ID=$(curl -s $URL/api/query -H 'Content-Type: application/json' \
    -d "{\"path\":\"models:getBySlug\",\"args\":{\"slug\":\"$slug\"}}" | jq -r .value._id)
  printf "%s " "$slug"
  curl -s $URL/api/query -H 'Content-Type: application/json' \
    -d "{\"path\":\"modelScores:getSchedulingStats\",\"args\":{\"modelId\":\"$ID\"}}" | jq .value.averageRunCostUsd
done
```

Estimate = 2 x the sum of the averages x the share of evals the filter matches. Count with `ls -d evals/*/*/ | wc -l` and `ls -d evals/*/*/ | sed 's|^evals/||; s|/$||' | grep -cE '<filter>'`. On 2026-09-29 the four defaults averaged about $22.60 per full suite, so an unfiltered run cost about $45 and `--filter "002-queries"` (28 of 112 evals) about $11.

Recommend `--filter` to the categories the change affects. State the estimate and wait for approval before running. Every re-run needs its own estimate and approval.

## Step 6: Run the validation script and monitor to completion

Do **not** set `CONVEX_EVAL_URL` or `CONVEX_AUTH_TOKEN` so results stay local.

```bash
bun run validate:guidelines --before <tmp>/before.md --after <tmp>/after.md --models anthropic/claude-sonnet-5,anthropic/claude-opus-4.8,deepseek/deepseek-v4-pro,openai/gpt-5.5 --filter "002-queries"
```

Optional: `--output <path>` to write the JSON summary to a specific file. By default it is written to `guideline-validation/results/<timestamp>.json`.

The script runs each model sequentially: first all evals with "before" guidelines, then all evals with "after" guidelines. Pass/fail is collected and deltas are computed.

**IMPORTANT: You must orchestrate the entire run end-to-end.** Start the command in the background with its output redirected to a log file, then read the log periodically until the run finishes (look for the `GUIDELINE VALIDATION SUMMARY` banner and the process exiting). Use exponential backoff for polling (e.g. 30s, 60s, 120s). Do NOT return to the user until the run is fully complete and you have read and analyzed the results. The user expects a complete report, not a "check back later" handoff.

### Or dispatch the GitHub workflow

Validate Guideline Changes (`.github/workflows/validate_guidelines.yml`) runs the same script in CI. It is manual dispatch only. It compares `origin/main` (input `base_ref`) against `runner/models/guidelines.md` on the dispatched branch, and each model (input `models`, default the four above) runs the suite twice, before and after. That makes it a paid run. Estimate the cost as in Step 5 and get approval before dispatching, the same as a local run. Push the branch first, then:

```bash
gh workflow run validate_guidelines.yml --ref <branch> -f filter='002-queries'
```

Read the summary in the job log (`gh run view <id> --log`). The JSON summary is uploaded as the `guideline-validation-<run id>` artifact.

## Step 7: Parse and report results

The script prints:

1. A **comparison table**: per-model before pass count, after pass count, delta, number of regressions, number of improvements.
2. **Regressions**: evals that passed before and failed after (by model).
3. **Improvements**: evals that failed before and passed after (by model).
4. A **verdict** line: either "REGRESSIONS DETECTED" or "Safe to commit."

Read the script output and present the full summary table and verdict to the user.

- If there are regressions: list them and recommend reverting or narrowing the guideline change; optionally run analyze-eval on a regression to see why it failed.
- If there are no regressions: recommend committing the guideline change; mention any improvements.

## Step 8: Recommend next steps

- **No regressions, with or without improvements**: Safe to commit the guideline changes.
- **Any regressions**: Do not commit. Suggest reverting the change or narrowing it (e.g. only add the new rule to a subsection that doesn’t affect the regressed eval). Re-run validation after adjusting.
- **Unclear or noisy**: If only one model regresses one eval, consider re-running that model to check for flakiness, or run the full suite once more.

## Reference: Script usage

```
bun run validate:guidelines --before <path> --after <path> --models <m1,m2,...> [--filter <regex>] [--output <path>]
```

- `--before`, `--after`: Paths to guideline markdown files (current vs proposed).
- `--models`: Comma-separated OpenRouter slugs from `ALL_MODELS` in `runner/models/index.ts` (e.g. `openai/gpt-5.5`, `anthropic/claude-sonnet-5`).
- `--filter`: Optional regex on eval `category/name` (e.g. `005-idioms` or `002-queries/015`).
- `--output`: Optional path for the JSON summary file.

`OPENROUTER_API_KEY` is loaded from `.env` via dotenv (see AGENTS.md). The script does not report to Convex.
