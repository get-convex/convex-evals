---
name: Auto CI Frequency
overview: Replace the three CI workflows (daily/weekly/monthly) with a single daily workflow. For "auto" models, compute a continuous target interval (in days) from run count, score variance, and model age, then include only models that are due to run today.
todos:
  - id: convex-query
    content: Add getSchedulingStats public query to evalScores/convex/runs.ts
    status: completed
  - id: preview-script
    content: Write runner/previewScheduling.ts - queries production and prints a table of computed intervals + projections
    status: completed
  - id: deploy-and-preview
    content: Commit/push to main to deploy the query, then run the preview script and share output with user
    status: completed
  - id: model-type
    content: "PHASE 2 (after approval): Add 'auto' to CIRunFrequency, make ciRunFrequency optional, remove explicit values from all models"
    status: pending
  - id: list-models
    content: "PHASE 2: Rewrite runner/listModels.ts to compute continuous intervals and return models due today"
    status: pending
  - id: workflow-consolidate
    content: "PHASE 2: Replace daily/weekly/monthly workflow YAMLs with a single scheduled_evals.yml"
    status: pending
  - id: typecheck
    content: Run bun run typecheck after each phase
    status: completed
isProject: false
---

# Auto-Calculate CI Run Frequency

## Goal

Replace the three separate CI workflows (daily/weekly/monthly) with a **single daily workflow** that runs every day and decides which models are due to run based on a computed target interval. "Auto" models get a continuous interval calculated from run count, score variance, and model age. Manual overrides (using the existing bucket names or "never") still work.

**All existing models will eventually have `ciRunFrequency` removed** (defaulting to "auto"), including older ones like Claude 3.5 Sonnet - those will simply retire automatically via the age threshold.

---

## Phase 1 - Implement + Preview (do now)

### Step 1: Add `getSchedulingStats` to `[evalScores/convex/runs.ts](evalScores/convex/runs.ts)`

New public query returning scheduling data for a list of models:

```typescript
export const getSchedulingStats = query({
  args: { models: v.array(v.string()) },
  returns: v.array(
    v.object({
      model: v.string(),
      completedRunCount: v.number(), // all time, no cap
      scoreStdDev: v.number(), // from last 5 completed runs
      lastRunTime: v.union(v.number(), v.null()),
      firstRunTime: v.union(v.number(), v.null()),
    }),
  ),
});
```

### Step 2: Add `runner/previewScheduling.ts`

A local script that:

1. Calls `getSchedulingStats` on the production Convex URL for all models in `ALL_MODELS`
2. Applies the interval formula (same code that `listModels.ts` will eventually use)
3. Prints two tables:

**Table A - Current state** (one row per model):

```
Model               | Runs | StdDev | Age(d) | TargetInterval | LastRun(d ago) | Due today?
Claude 3.5 Sonnet   |  24  |  0.02  |  195   | RETIRED        |      8         | no
Claude 4.6 Opus     |   8  |  0.04  |   45   | 11 days        |     12         | yes
...
```

**Table B - Projection** (how targetInterval changes as runs accumulate, at current stdDev):

```
Model               | StdDev | @5runs | @10runs | @15runs | @20runs
Claude 4.6 Opus     |  0.04  |  2d    |   10d   |   18d   |   23d
...
```

### Step 3: Commit, push to main, deploy, run preview

- Commit just the Convex query (no other changes)
- Push to main → triggers `release.yml` → deploys to production
- Run `bun run runner/previewScheduling.ts` locally to query production
- Share output for review

---

## Phase 2 - Wire It Up (after approval)

### 1. `[runner/models/index.ts](runner/models/index.ts)`

- Add `"auto"` to `CIRunFrequency`
- Make `ciRunFrequency` optional in `ModelTemplate` (defaults to `"auto"`)
- Remove `ciRunFrequency` from all model definitions

### 2. `[runner/listModels.ts](runner/listModels.ts)`

New mode `--mode scheduled` (used by CI):

- Fetch `getSchedulingStats` from Convex for all models
- Compute `targetDays` per model
- Return only models where `daysSinceLastRun >= targetDays` (or never run)
- Graceful fallback if Convex unreachable: run all models (conservative)

Existing `--frequency <bucket>` mode preserved for manual/local use.

### 3. GitHub Actions workflows

- Delete `weekly_evals.yml` and `monthly_evals.yml`
- Update `daily_evals.yml` in place: rename to "Scheduled Convex Evaluations", keep cron `"0 0 * * *"`, change setup step from `--frequency daily` to `--mode scheduled`

---

## Interval Formula

```
BOOTSTRAP_RUNS  = 5
TARGET_RUNS     = 20
BASE_INTERVAL   = 30     // days
MIN_INTERVAL    = 2
VARIANCE_NORM   = 0.05
RETIRE_AGE_DAYS = 180

if completedRuns < BOOTSTRAP_RUNS:
    targetDays = 2

elif daysSinceFirstRun > RETIRE_AGE_DAYS:
    targetDays = Infinity  // retired

else:
    dataConfidence  = min(completedRuns / TARGET_RUNS, 1.0)
    variancePenalty = stdDev / VARIANCE_NORM
    targetDays = max(MIN_INTERVAL,
                   BASE_INTERVAL * dataConfidence / (1 + variancePenalty))
```

Manual overrides (`ciRunFrequency` set explicitly) bypass this formula entirely and map to fixed intervals: `daily=1d`, `weekly=7d`, `monthly=30d`, `never=excluded`.
