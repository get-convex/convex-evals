# Client-owned web rollout

## Current state

- `no_guidelines_with_web` runs with client-owned Exa search and fetch tools. It
  reuses the experiment name: the old server-tool web runs were deleted on
  2026-09-16. Do not mix old server-tool results with client-tool runs.
- The repository variables `ENABLE_NO_GUIDELINES_WITH_WEB` and
  `ENABLE_CLIENT_WEB_PRODUCTION` have both been `true` since 2026-09-16. The first
  adds the web condition to Periodic Evaluations; `false` removes it. The second
  lets GitHub Actions on `main` report client-web runs; `false` makes those runs
  fail at startup.
- Periodic Evaluations was re-enabled on 2026-09-29 after #343. It skips only the
  web condition for models in `PERIODIC_WEB_EXCLUDED_MODELS`
  (`runner/models/index.ts`). Remove an entry to let the schedule retry that model.
  Manual Model Evaluations ignores the list.
- Production Exa key: `convex-evals-production`, stored as the repository Actions
  secret `EXA_API_KEY`. Local `.env` keeps the development key. Both keys share the
  Exa team's billing and rate limit.
- Local web runs must set `DISABLE_CONVEX_REPORTING=1`. See
  [Local reruns](web-source-filtering.md#local-reruns).
- Backup and deletion evidence for the old runs live outside Git under
  `/Users/m5-mike/Documents/Codex/web-experiment-reset-2026-09-16/`.

## Rollback

Disable the web schedule and stop new web runs. Retain trace artifacts and the
pre-reset backup. Do not fall back automatically to server-side search: that would
reintroduce unobservable calls into the same experiment. Baseline runs remain
independent of this rollout.
