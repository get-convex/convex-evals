---
name: validate-guidelines
description: Empirically verify guideline changes by running before/after eval runs across multiple models and ensuring no regressions. Use when proposing or reviewing changes to runner/models/guidelines.ts, or when the user asks to validate guidelines.
---

# Validate Guidelines

## When to use

- User proposes or has made changes to `runner/models/guidelines.ts` and wants to ensure they don't regress other models
- User says "validate the guideline changes" or "run the guideline validation"
- Before committing guideline edits, to confirm improvements or no-regression across sonnet, opus, gemini, chatgpt (or a subset)

## Overview

Guideline changes are validated by running evals twice per model: once with the **current** (before) guidelines and once with the **proposed** (after) guidelines. Results are compared; any eval that passed before and fails after is a regression. The goal is to ensure changes improve or at least do not regress scores across multiple models.

## Step 1: Identify the change

Determine which guideline sections were modified in `runner/models/guidelines.ts` (e.g. `function_guidelines`, `query_guidelines`, `file_storage_guidelines`) and the intent (new rule, clarification, token compaction).

## Step 2: Build before and after guideline files

- **Before**: Current committed guidelines. Generate by running `bun run buildRelease.ts` and use `dist/AGENTS.md`, or render compact guidelines to a temp file. If the repo is in a clean state, `dist/AGENTS.md` after build is the "before" snapshot.
- **After**: Guidelines with the proposed changes. Either:
  - Temporarily apply the proposed edits to `runner/models/guidelines.ts`, run `bun run buildRelease.ts`, copy `dist/AGENTS.md` to a temp path (e.g. `guideline-validation/after.md`), then revert the file; or
  - Write the proposed full guideline markdown to a temp file (e.g. by building from a branch or a copy of the file).

Ensure both paths are absolute or relative to the repo root and that the script can read them.

## Step 3: Select target evals

Use the mapping below to choose a `--filter` regex or omit it for the full suite.

| Guideline section | Suggested TEST_FILTER (regex) |
|-------------------|--------------------------------|
| `function_guidelines` (http, validators, registration, calling, pagination) | `000-fundamentals\|006-clients` or full |
| `validator_guidelines` | `000-fundamentals/009` |
| `schema_guidelines` | `001-data_modeling` |
| `typescript_guidelines` | Omit (run all) |
| `full_text_search_guidelines` | `002-queries/009\|002-queries/020` |
| `query_guidelines` | `002-queries` |
| `mutation_guidelines` | `003-mutations` |
| `action_guidelines` | `004-actions` |
| `scheduling_guidelines` | `000-fundamentals/003\|000-fundamentals/004` |
| `file_storage_guidelines` | `000-fundamentals/007\|004-actions/004\|004-actions/005` |

- **Targeted change** (e.g. one section): use a filter that matches the evals most likely affected.
- **Broad change** (e.g. wording across many sections): omit `--filter` to run all evals.

## Step 4: Select models

Default set (preferred for validation): `claude-sonnet-4-5`, `claude-opus-4-6`, `gemini-3-pro-preview`, `gpt-5.2-codex`.

Check which API keys are set in `.env` (e.g. `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`). The script skips models whose provider key is missing and prints a warning. Use a subset if some keys are unavailable; at least two models are recommended.

## Step 5: Run the validation script and monitor to completion

Do **not** set `CONVEX_EVAL_URL` or `CONVEX_AUTH_TOKEN` so results stay local.

```bash
bun run validate:guidelines --before <path-to-before.md> --after <path-to-after.md> --models claude-sonnet-4-5,claude-opus-4-6,gemini-3-pro-preview,gpt-5.2-codex
```

With an eval filter:

```bash
bun run validate:guidelines --before <before.md> --after <after.md> --models claude-sonnet-4-5,gpt-5.2-codex --filter "002-queries"
```

Optional: `--output <path>` to write the JSON summary to a specific file. By default it is written to `guideline-validation/results/<timestamp>.json`.

The script runs each model sequentially: first all evals with "before" guidelines, then all evals with "after" guidelines. Pass/fail is collected and deltas are computed.

**IMPORTANT: You must orchestrate the entire run end-to-end.** Start the command in the background (`block_until_ms: 0`), then poll the terminal output file periodically until the run finishes (look for the `exit_code` footer or the `GUIDELINE VALIDATION SUMMARY` banner). Use exponential backoff for polling (e.g. 30s, 60s, 120s). Do NOT return to the user until the run is fully complete and you have read and analyzed the results. The user expects a complete report, not a "check back later" handoff.

## Step 6: Parse and report results

The script prints:

1. A **comparison table**: per-model before pass count, after pass count, delta, number of regressions, number of improvements.
2. **Regressions**: evals that passed before and failed after (by model).
3. **Improvements**: evals that failed before and passed after (by model).
4. A **verdict** line: either "REGRESSIONS DETECTED" or "Safe to commit."

Read the script output and present the full summary table and verdict to the user.

- If there are regressions: list them and recommend reverting or narrowing the guideline change; optionally run analyze-eval on a regression to see why it failed.
- If there are no regressions: recommend committing the guideline change; mention any improvements.

## Step 7: Recommend next steps

- **No regressions, with or without improvements**: Safe to commit the guideline changes.
- **Any regressions**: Do not commit. Suggest reverting the change or narrowing it (e.g. only add the new rule to a subsection that doesn’t affect the regressed eval). Re-run validation after adjusting.
- **Unclear or noisy**: If only one model regresses one eval, consider re-running that model to check for flakiness, or run the full suite once more.

## Reference: Script usage

```
bun run validate:guidelines --before <path> --after <path> --models <m1,m2,...> [--filter <regex>] [--output <path>]
```

- `--before`, `--after`: Paths to guideline markdown files (current vs proposed).
- `--models`: Comma-separated model names from `runner/models/index.ts` (e.g. `gpt-5.2-codex`, `claude-sonnet-4-5`).
- `--filter`: Optional regex on eval `category/name` (e.g. `005-idioms` or `002-queries/015`).
- `--output`: Optional path for the JSON summary file.

API keys are loaded from `.env` via dotenv (see AGENTS.md). The script does not report to Convex.
