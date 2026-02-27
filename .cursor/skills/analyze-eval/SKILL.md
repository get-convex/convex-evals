---
name: analyze-eval
description: Investigate a single failing eval from the convex-evals system. Use when the user shares a visualizer URL pointing to a specific eval, asks about a specific failing eval, or references a specific eval ID.
---

# Analyze Eval

## When to use

- User shares a URL like `https://convex-evals.netlify.app/experiment/.../run/$runId/$category/$evalId`
- User asks "why did this eval fail?" or "what went wrong with this eval?"
- User references a specific eval ID

## Step 1: Extract the eval ID from the URL

The visualizer URL pattern is:

```
/experiment/$experimentId/run/$runId/$category/$evalId?tab=steps
```

- `$runId` — the Convex document ID for the run (e.g. `jn7922j1w29pdxm76bj9ps0enx80mg9e`)
- `$evalId` — the Convex document ID for the specific eval (e.g. `jh73jvjz2n00gfeve1dt5h963s80mbc6`)

You need the **evalId** to query.

## Step 2: Query the debug action

Run the internal action from the `evalScores/` directory. Always use `--prod` to query the production database (where CI writes results):

```bash
npx convex run --prod debug:getEvalDebugInfo '{"evalId": "<evalId>"}'
```

This returns a JSON object with:

| Field | Contents |
|-------|----------|
| `eval` | Name, category, evalPath, status (pass/fail + failure reason), task text |
| `run` | Model name, provider, experiment name, run status |
| `steps` | Array of step results: filesystem, install, deploy, tsc, eslint, tests — each with pass/fail/skipped and failure reason |
| `outputFiles` | Map of file path -> file content from the model's generated output (unzipped) |
| `evalSourceFiles` | Map of file path -> file content from the eval source (answer dir, grader, TASK.txt, etc.) |

## Step 3: Analyze the failure

With the data returned, compare:

1. **Which step failed?** — Check `steps` for the first entry with `status.kind === "failed"`. The `failureReason` field has the error message.
2. **What did the model generate?** — Look at `outputFiles` for the model's code.
3. **What was expected?** — Look at `evalSourceFiles` for the answer directory and grader test files.
4. **What was the task?** — Check `eval.task` for the TASK.txt content.

Common failure patterns:
- **eslint fail** — Check the failure reason for the specific lint rule violated. Compare the model output against the answer to spot the lint issue.
- **tsc fail** — TypeScript compilation error. Check the failure reason for the specific type error.
- **convex dev fail** — Schema or function definition issues that prevent Convex from deploying.
- **tests fail** — The grader tests didn't pass. Compare `outputFiles` against `evalSourceFiles` (look for files like `grader.test.ts` or `answer/`) to understand what the tests expected.

## Step 4: Classify and report findings

Classify the failure as one of:
- **MODEL_FAULT**: The model genuinely got it wrong
- **OVERLY_STRICT**: The eval/lint/test requirements are unreasonable for what was asked
- **AMBIGUOUS_TASK**: The task description is unclear and the model's interpretation was reasonable
- **KNOWN_GAP**: A known limitation of this eval that affects all models (e.g. the Convex API returns fields the model can't predict without being told)

Summarize:
1. The eval name, model, and experiment
2. Which step failed and the exact error
3. The classification and reasoning
4. The relevant code from the model output that caused the failure
5. What the correct code should look like (from the answer/eval source)
6. Whether any action is recommended (config change, task clarification, etc.)
