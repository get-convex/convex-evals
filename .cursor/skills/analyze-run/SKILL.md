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

## Step 2: Check previous reports for this model

Reports are stored in `reports/{provider}/{model}/` (e.g. `reports/anthropic/claude-opus-4-6/`).
List the directory for the model being analyzed and read the most recent report(s). This gives you:
- Known recurring failures for this model
- Actions already taken (lint config changes, grader fixes, task updates)
- Classifications from prior analysis that may still apply

Reference prior findings when the same eval fails again — note whether it's a repeat and whether any prior fix should have resolved it.

## Step 3: Fetch the failure summary

Run from the `evalScores/` directory:

```bash
npx convex run --prod debugQueries:getFailedEvalsForRun '{"runId": "<runId>"}'
```

This returns:
- `run` -- model name, provider, experiment, status
- `totalEvals`, `passedCount`, `failedCount` -- overall stats
- `failedEvals` -- array of failed evals, each with `_id`, `evalPath`, `category`, `name`, `failureReason`, and `failedStep` (which step failed and its error)

If there are no failures, report that all evals passed and stop.

## Step 4: Fan out sub-agents to analyze each failure

For each failed eval, spawn a sub-agent (up to 4 in parallel) with this prompt template:

```
You are investigating a failing eval from the convex-evals system.

The workspace is at c:\dev\convex\convex-evals
Run this command from the evalScores/ directory:

npx convex run --prod debug:getEvalDebugInfo '{"evalId": "<EVAL_ID>"}'

Then analyze the result:
1. Which step failed and what was the exact error?
2. Look at the model's generated code in outputFiles.
3. Look at the expected answer and grader in evalSourceFiles.
4. Look at the task description in eval.task.
5. Is this a genuine model mistake, or is the test/lint/task unfair?

Classify the failure as one of:
- MODEL_FAULT: The model genuinely got it wrong
- OVERLY_STRICT: The eval/lint/test requirements are unreasonable for what was asked
- AMBIGUOUS_TASK: The task description is unclear and the model's interpretation was reasonable
- KNOWN_GAP: Check evalSourceFiles for a GAPS.txt that documents this issue

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
- Do the GAPS.txt files already acknowledge these issues?

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

For example: `reports/anthropic/claude-opus-4-6/jn72t14a_2026-02-06.md`

The `runIdPrefix` is the first 8 characters of the run ID.

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
