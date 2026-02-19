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
4. **API kind requirement** - choose `apiKind` based on how the model is accessed:
   - Use `apiKind: "responses"` for models that require the Responses API.
   - For non-Responses models, `apiKind: "chat"` is the default and `apiKind` can be left unset.

If unsure about `apiKind`, check the closest existing model in the same family in `runner/models/index.ts` and match it.

## Step 1: Add the Model to `runner/models/index.ts`

Open `runner/models/index.ts` and add a new entry to the `ALL_MODELS` array. Place it next to its family siblings, respecting the existing grouping comments.

Set `ciRunFrequency: "daily"` for the new model (it's the latest and should run most often).

**Template:**

```typescript
{
  name: "<provider>/<model-id>",
  formattedName: "<Human Name>",
  ciRunFrequency: "daily",
  // only when needed:
  apiKind: "responses",
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

## Step 3: Add to the Manual Evals Workflow

Open `.github/workflows/manual_evals.yml` and add the new model's name to the `matrix.model` list so it can be triggered on-demand.

## Step 4: Typecheck

Run `bun run typecheck` to verify no type errors were introduced.

## Step 5: Commit and Push

Create a descriptive commit message and push to `main`:

```
git add runner/models/index.ts .github/workflows/manual_evals.yml
git commit -m "add <model-name>; demote older <family> versions"
git push origin main
```

## Step 6: Trigger Manual Eval Runs for Baseline Data

Use the GitHub CLI to dispatch the manual eval workflow **3 times** (to get a statistically meaningful baseline):

```bash
gh workflow run manual_evals.yml --ref main
```

Run this command 3 times, waiting ~5 seconds between dispatches to avoid collisions.

## Step 7: Monitor the Runs

List and watch the triggered runs:

```bash
gh run list --workflow=manual_evals.yml --limit=6
```

Poll periodically until all 3 runs complete. Report the final status (success/failure) and any errors to the user. If a run fails, investigate the logs:

```bash
gh run view <run-id> --log-failed
```

## Summary Checklist

- [ ] Model added to `ALL_MODELS` in `runner/models/index.ts` with `ciRunFrequency: "daily"`
- [ ] Older family versions demoted (daily->weekly->monthly cascade)
- [ ] Model added to `.github/workflows/manual_evals.yml` matrix
- [ ] `bun run typecheck` passes
- [ ] Changes committed and pushed to `main`
- [ ] Manual eval workflow dispatched 3 times
- [ ] All 3 runs monitored to completion
