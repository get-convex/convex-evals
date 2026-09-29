---
name: add-model
description: Add a new model to the convex-evals coding leaderboard, and optionally the decision benchmark, through a PR, then dispatch its baseline runs. Use when the user wants to add or onboard a model, or names a new model or OpenRouter link for the leaderboard.
---

# Add a model

Every model runs through OpenRouter. The runner takes any OpenRouter slug and looks up the display name and API kind at run time (`runner/models/openRouterDiscovery.ts`). Adding a model is a list change in a PR plus paid baseline runs.

## 1. Find the OpenRouter slug

```bash
curl -s https://openrouter.ai/api/v1/models | jq -r '.data[] | "\(.id)\t\(.name)"' | grep -i sonnet
```

Use the plain slug, e.g. `anthropic/claude-sonnet-5.5`, not a `:batch` variant or a `~...-latest` alias. If the model isn't listed, the runner can't run it yet.

## 2. Add it to the lists

`ALL_MODELS` is the curated list. It feeds the periodic schedule, the curated cohort of the next benchmark mint, and the ablation and guideline-validation scripts.

- `runner/models/index.ts`: add the slug to `ALL_MODELS` next to its family. Entries are plain strings. Keep older siblings unless the maintainer says to drop them.
- `runner/models.test.ts`: add `expect(ALL_MODELS).toContain("<slug>");` to "contains the current curated models".

The decision benchmark is optional, so ask if unsure. Pick a short key without dots or dashes (`fable51`, `gemini38flash`) and add it in three places, next to its family each time:

- `DECISION_CI_MODELS` in `runner/decisions/ci.ts`, e.g. `fable51: { provider: "openrouter", model: "anthropic/claude-fable-5.1" },`
- the `model` input's `options` in `.github/workflows/decision_evals.yml`
- the `all` JSON array on the `matrix.model` line of the same file

`runner/decisions/ci.test.ts` fails if the three drift apart. PR #338 is a complete example.

`manual_evals.yml` needs no edit. It takes models as a dispatch input.

## 3. Smoke test locally

```bash
DISABLE_CONVEX_REPORTING=1 MODELS=<slug> TEST_FILTER="000-fundamentals/000-empty_functions|000-fundamentals/003-crons" bun run local:run
```

This reads `OPENROUTER_API_KEY` from the root `.env`. In a new worktree, run `bun run setup` first. It installs all dependencies and copies `.env` from another worktree.

Expect `[preflight] Endpoint is available` and a score for both evals. A low score is fine. `not supported and not found on OpenRouter` means a wrong slug. A model-specific request error, like Kimi K3 rejecting `temperature` (PR #225), needs a runner change, so stop and raise it.

## 4. Typecheck and test

```bash
bun run typecheck
bun run test
```

## 5. Open a PR

Open it against `main` with Why, What, Validation (smoke result, typecheck, test counts) and, if you added a decision key, After merge. PR #340 is the template. Never merge it or enable auto-merge. The maintainer merges.

## 6. Dispatch baseline coding runs

These don't wait for the merge. The runner discovers the slug, and dispatches on `main` report to the production leaderboard. Other refs run with reporting off.

State a dollar estimate and get approval first. Take per-run averages for a model at a similar price from the public production query `modelScores:getSchedulingStats`:

```bash
URL=https://fabulous-panther-525.convex.cloud
ID=$(curl -s $URL/api/query -H 'Content-Type: application/json' \
  -d '{"path":"models:getBySlug","args":{"slug":"anthropic/claude-sonnet-5"}}' | jq -r .value._id)
for exp in '' ',"experiment":"no_guidelines"' ',"experiment":"no_guidelines_with_web"'; do
  curl -s $URL/api/query -H 'Content-Type: application/json' \
    -d "{\"path\":\"modelScores:getSchedulingStats\",\"args\":{\"modelId\":\"$ID\"$exp}}" | jq .value.averageRunCostUsd
done
```

That prints the default, no_guidelines and no_guidelines_with_web averages. Web costs include Exa charges. One dispatch runs all three conditions, so three dispatches cost three times the sum. Sonnet 5 on 2026-09-29: $4.17 + $1.82 + $2.55 = $8.54 per dispatch, about $26 total.

Then dispatch three times:

```bash
gh workflow run manual_evals.yml --ref main -f models=<slug> -f run_guidelines=true -f run_no_guidelines=true -f run_no_guidelines_with_web=true
```

- Web runs fail unless the repo variable `ENABLE_CLIENT_WEB_PRODUCTION` is `true` (`gh variable list`). The workflow supplies `EXA_API_KEY` and `CLIENT_WEB_TOOLS=1`.
- If the provider rate-limits, pass `-f max_concurrency=2` or `1`.
- The conditions are sequential steps in one job, and a failed step skips the rest. Re-dispatch just the missing ones with the others set to `false`.
- In a web run, a provider or Exa error that survives its retries aborts the whole run, which is marked failed rather than scored. Read the log, re-dispatch, and don't count it.

Find the runs with `gh run list --workflow=manual_evals.yml --limit 3`, follow one with `gh run watch <id>`, and read failures with `gh run view <id> --log-failed`.

## 7. Dispatch decision runs after the merge

Skip this if you didn't add a decision key. The workflow only runs on `main`, and `ci.ts` rejects keys it doesn't know, so nothing works before the merge.

Each job stops at $5 of known cost, which isn't a hard cap when a provider omits cost. Quote up to $15 and get approval, then dispatch three times, like every current decision model:

```bash
gh workflow run decision_evals.yml --ref main -f model=<key>
```

Always pass `model`. Its default, `all`, runs every decision model. `condition` defaults to `no_guidelines`, the only condition used so far.

## 8. Check the periodic schedule

```bash
gh workflow list --all
```

If Periodic Evaluations is `disabled_manually`, the model only gets the manual runs above until the maintainer re-enables it. Don't re-enable it yourself. New models never need a benchmark mint. They score under the current version.
