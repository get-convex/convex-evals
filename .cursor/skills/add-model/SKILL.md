---
name: add-model
description: Add a new AI model to the eval runner, adjust CI frequencies for older model versions, update the manual eval workflow, push changes, and trigger baseline eval runs. Use when the user wants to add a new model, onboard a model, or mentions a new model name/link to add to the leaderboard.
---

# Add a New Model to the Eval Runner

Follow these steps whenever the user asks to add a new AI model to the eval suite.

## Step 0: Gather Information

Determine the following (ask the user if not provided):

1. **Model identifier** - the OpenRouter-style name, e.g. `anthropic/claude-opus-4.6`. If the user gives a marketing name or URL, look up the OpenRouter model id.
2. **Formatted name** - human-readable, e.g. `Claude 4.6 Opus`.
3. **Provider family & version** - needed to find older siblings (e.g. `claude-opus-4.5` is the predecessor of `claude-opus-4.6`).
4. **`apiKind`** - only needed for OpenAI Codex/Responses-API models; set to `"responses"`. Omit for all other models.

If you're unsure, check how the closest existing model in the same family is configured in `runner/models/index.ts` and match it.

## Step 1: Add the Model to `runner/models/index.ts`

Open `runner/models/index.ts` and add a new entry to the `ALL_MODELS` array. Place it next to its family siblings, respecting the existing grouping comments.

Set `ciRunFrequency: "daily"` for the new model (it's the latest and should run most often).

**Template:**

```typescript
{
  name: "<provider>/<model-id>",
  formattedName: "<Human Name>",
  ciRunFrequency: "daily",
  // apiKind: "responses",  // only for OpenAI Codex / Responses-API models
},
```

## Step 2: Demote Older Versions in the Same Family

Look at the **same model family** in `ALL_MODELS` (same provider prefix and model line, e.g. all `anthropic/claude-opus-*` models) and apply this frequency cascade:

| Relative age | Frequency |
|---|---|
| **Latest (just added)** | `daily` |
| **Previous version** (was daily) | `weekly` |
| **Two versions back** (was weekly) | `monthly` |
| **Three+ versions back** | `monthly` (floor) |

Only demote a model if it was at a *higher* frequency than the target. Never promote an older model.

For example, when adding `claude-opus-4.6` (daily):
- `claude-opus-4.5` moves from `daily` -> `weekly`
- `claude-opus-4` (if it existed at weekly) -> `monthly`

## Step 3: Update the Manual Evals Workflow

Open `.github/workflows/manual_evals.yml` and **replace** the entire `matrix.model` list with only the new model. This workflow exists solely to collect baseline data for newly added models, so it should only ever contain the latest addition.

```yaml
matrix:
  model:
    - "<provider>/<model-id>"
```

## Step 4: Typecheck

Run `bun run typecheck` to verify no type errors were introduced.

## Step 5: Smoke Test the New Model Locally

Before committing, run a quick local sanity check with one or two simple evals to confirm the model ID is valid, the API key works, and results are being produced. Use the simplest fundamentals evals:

```bash
MODELS=<new-model-name> TEST_FILTER="000-fundamentals/000" bun run local:run
```

If that passes, optionally run one more:

```bash
MODELS=<new-model-name> TEST_FILTER="000-fundamentals/001" bun run local:run
```

**What to look for:**
- No authentication or "model not found" errors
- The run completes and produces a score (even a low score is fine - we just want to confirm it runs)
- If it fails with an API/auth error, stop and fix the model ID or check the `.env` file before proceeding

Only proceed to the next step once at least one eval completes successfully.

## Step 6: Commit and Push

Create a descriptive commit message and push to `main`:

```
git add runner/models/index.ts .github/workflows/manual_evals.yml
git commit -m "add <model-name>; demote older <family> versions"
git push origin main
```

## Step 7: Trigger Manual Eval Runs for Baseline Data

Use the GitHub CLI to dispatch the manual eval workflow **3 times** (to get a statistically meaningful baseline):

```bash
gh workflow run manual_evals.yml --ref main
```

Run this command 3 times, waiting ~5 seconds between dispatches to avoid collisions.

## Step 8: Monitor the Runs Until Completion

**You MUST poll until all 3 runs reach a terminal state (completed/failed/cancelled). Do not stop monitoring early or hand back to the user while runs are still in progress.**

Poll every ~2 minutes using:

```bash
gh run list --workflow=manual_evals.yml --limit=6
```

Runs typically take 20-30 minutes. Keep checking until all show `completed`. If a run fails, immediately investigate:

```bash
gh run view <run-id> --log-failed
```

Report the final pass/fail status for each run to the user once all 3 are done.

## Summary Checklist

- [ ] Model added to `ALL_MODELS` in `runner/models/index.ts` with `ciRunFrequency: "daily"`
- [ ] Older family versions demoted (daily->weekly->monthly cascade)
- [ ] `.github/workflows/manual_evals.yml` matrix replaced with only the new model
- [ ] `bun run typecheck` passes
- [ ] Smoke test: at least one eval completes successfully locally
- [ ] Changes committed and pushed to `main`
- [ ] Manual eval workflow dispatched 3 times
- [ ] All 3 runs monitored to completion
