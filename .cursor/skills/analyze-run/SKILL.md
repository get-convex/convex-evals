---
name: analyze-run
description: Analyze all failures in a convex-evals run, spawning parallel sub-agents to investigate each failure and producing a report with classifications and recommendations. Use when the user asks to analyze an entire run, review all failures in a run, or wants to understand why a model scored poorly.
---

# Analyze Run

## When to use

- User asks "analyze this run" or "why did this model score poorly?"
- User shares a run URL like `https://convex-evals.netlify.app/experiment/.../run/$runId/...`
- User wants to review all failures across an entire eval run

## Step 1: Get the run ID

Extract the run ID from the visualizer URL. The URL pattern is:

```
/experiment/$experimentId/run/$runId/...
```

The `$runId` is the Convex document ID (e.g. `jn7922j1w29pdxm76bj9ps0enx80mg9e`).

This skill covers coding runs only. For a decision run (visualizer URLs under `/decision/run/`), the queries below throw "This operation requires a coding run", which the public API reports as a bare "Server Error".

## Step 2: Check previous reports for this model

Reports are stored in `reports/{provider}/{model}/`, where `{provider}/{model}` is the run's model slug (the `model` field from Step 3), e.g. `reports/anthropic/claude-opus-4.8/` for `anthropic/claude-opus-4.8`. Don't use the run's `provider` field. It stores the OpenRouter endpoint provider (or `openrouter` when discovery failed), which can differ from the slug's vendor.
List the directory for the model being analyzed and read the most recent report(s). This gives you:
- Known recurring failures for this model
- Actions already taken (lint config changes, grader fixes, task updates)
- Classifications from prior analysis that may still apply

Reference prior findings when the same eval fails again — note whether it's a repeat and whether any prior fix should have resolved it.

## Step 3: Fetch the failure summary

Use the public production query `runs:getRunDetails` over HTTP. It needs no login:

```bash
URL=https://fabulous-panther-525.convex.cloud
curl -s $URL/api/query -H 'Content-Type: application/json' \
  -d '{"path":"runs:getRunDetails","args":{"runId":"<runId>"}}' > /tmp/run-<runId>.json
jq '.value | {model, provider, experiment, status: .status.kind,
  totalEvals: (.evals | length),
  passedCount: ([.evals[] | select(.status.kind == "passed")] | length),
  failedEvals: [.evals[] | select(.status.kind == "failed") | {_id, evalPath,
    failureReason: .status.failureReason,
    failedStep: ([.steps[] | select(.status.kind == "failed") | {name, failureReason: .status.failureReason}] | first)}]}' /tmp/run-<runId>.json
```

This returns:
- `model` (the slug), `provider`, `experiment` (`null` means default), `status` -- run metadata
- `totalEvals`, `passedCount` -- overall stats
- `failedEvals` -- array of failed evals, each with `_id`, `evalPath`, `failureReason`, and `failedStep` (which step failed and its error)

If there are no failures, report that all evals passed and stop.

Don't use `npx convex run --prod` for this. The debug functions (`debugQueries:getFailedEvalsForRun`, `debug:getEvalDebugInfo`) are internal, and agents usually hit team SSO ("Single-sign on login is required").

## Step 4: Fan out sub-agents to analyze each failure

For each failed eval, spawn a sub-agent (up to 4 in parallel) with this prompt template. Fill in `<REPO_ROOT>` with the absolute path from `git rev-parse --show-toplevel`. If a sub-agent can't fetch its eval, give Mike this command to run and paste back: `cd evalScores && npx convex run --prod debug:getEvalDebugInfo '{"evalId": "<EVAL_ID>"}'`.

```
You are investigating a failing eval from the convex-evals system.

The repo root is <REPO_ROOT>. Work in a new temp directory, not the repo.
Fetch the eval from the public production API (no login needed):

URL=https://fabulous-panther-525.convex.cloud
curl -s $URL/api/query -H 'Content-Type: application/json' \
  -d '{"path":"runs:getRunDetails","args":{"runId":"<RUN_ID>"}}' \
  | jq '.value.evals[] | select(._id == "<EVAL_ID>")' > eval.json

eval.json has the task text (task), status (failureReason, outputStorageId),
evalSourceStorageId, and steps. Get a download URL for each storage ID:

curl -s $URL/api/query -H 'Content-Type: application/json' \
  -d '{"path":"runs:getOutputUrl","args":{"storageId":"<STORAGE_ID>"}}' | jq -r .value

Download status.outputStorageId to output.zip and evalSourceStorageId to
source.zip with curl -s -o, then unzip each into output/ and source/.
Don't use npx convex run --prod. If a request fails, stop and report the error.

Then analyze the result:
1. Which step failed and what was the exact error?
2. Look at the model's generated code in output/.
3. Look at the expected answer and grader in source/.
4. Look at the task description in eval.json's task field.
5. Is this a genuine model mistake, or is the test/lint/task unfair?

Classify the failure as one of:
- MODEL_FAULT: The model genuinely got it wrong
- OVERLY_STRICT: The eval/lint/test requirements are unreasonable for what was asked
- AMBIGUOUS_TASK: The task description is unclear and the model's interpretation was reasonable
- KNOWN_GAP: A known limitation of this eval that affects all models (e.g. the Convex API returns fields the model can't predict without being told)

Return a structured summary:
- Eval: <name> (<category>)
- Failed step: <step name>
- Error: <one-line error summary>
- Classification: <one of the above>
- Reasoning: <2-3 sentences explaining your classification>
- Model output snippet: <the relevant problematic code, if applicable>
- Expected code snippet: <what the answer looks like, if applicable>
```

## Step 5: Collate, present, and create report

Once all sub-agents return, build the analysis:

### 5a. Overall summary
- Model, experiment, pass rate (X/Y evals passed)
- Breakdown by failure type: how many eslint, tsc, deploy, test failures

### 5b. Failure classification table
For each failure, list: eval name, failed step, classification, one-line reasoning.

### 5c. Cross-cutting patterns
Look for patterns across failures:
- Are multiple failures caused by the same root issue? (e.g. same lint rule, same API misunderstanding, same missing pattern)
- Are there categories of evals that are systematically harder?
- Do prior reports for this model already document these issues?

### 5d. Recommendations
Group recommendations by type:
- **Eval improvements**: Tasks that should be clarified, tests that should be relaxed
- **Lint/config changes**: Rules that are too strict for what we're testing
- **Model-specific notes**: Patterns this model struggles with that other models might not
- **No action needed**: Failures that are genuinely the model's fault

### 5e. Create report file

Always create a report file at:

```
reports/{provider}/{model}/{runIdPrefix}_{date}.md
```

For example: `reports/anthropic/claude-opus-4.8/jn72t14a_2026-09-29.md` for a run of `anthropic/claude-opus-4.8`.

`{provider}/{model}` is the run's model slug, as in Step 2. The `runIdPrefix` is the first 8 characters of the run ID.

The report should contain:
- Run metadata (ID, model, experiment, date, pass rate)
- Failure summary table (by step type)
- Per-failure analysis with classification, reasoning, and code snippets
- Cross-cutting patterns (especially recurring failures from prior reports)
- Recommendations (eval improvements, lint/config changes, model-specific notes)
- Net impact assessment (how many failures are actionable vs genuine model faults)
- **Actions taken**: List any changes made as a result of this analysis (e.g. "Updated TASK.txt for 007-http_action_routing to clarify getSiteURL placement"). Default to "None" if no changes were made — this makes it explicit that recommendations were reviewed and deliberately not acted on, rather than simply forgotten.

### 5f. Present to user

Present the full analysis to the user. End with:

"These are my findings. Would you like me to implement any of these recommendations, or would you like to discuss specific failures in more detail?"

Do NOT make any code/config changes until the user explicitly asks.

### 5g. Update report after implementing changes

If the user asks you to implement any recommendations, **update the report file's "Actions taken" section** after making the changes. Record:
- What was changed (file path + brief description)
- Which failure(s) it addresses
- Date of the change

This ensures future analysis sessions can see which recommendations were already acted on and avoid re-recommending changes that have already been made.
