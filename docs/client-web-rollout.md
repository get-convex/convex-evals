# Client-owned web rollout

## Decision

Reuse `no_guidelines_with_web`. Michael approved deleting the old web runs on
16 September 2026 instead of adding an experiment value. No schema change is
needed. Do not mix old server-tool results with the replacement client-tool runs.

## Preparation

- Dedicated Exa production key: `convex-evals-production`, stored as the repository
  Actions secret `EXA_API_KEY`. Local `.env` retains the development key. Both keys
  share the Exa team's billing and rate limit.
- `ENABLE_NO_GUIDELINES_WITH_WEB` was set to `false` before cleanup. No queued or
  running Actions jobs were found. Keep it false until rollout is approved.
- Production target: `fabulous-panther-525`. Only runs whose experiment equals
  `no_guidelines_with_web` are in scope for deletion, including failed runs.
- Backup and deletion evidence live outside Git under
  `/Users/m5-mike/Documents/Codex/web-experiment-reset-2026-09-16/`.

## Cleanup verification

Deleted all 63 old web runs (28 completed and 35 failed) using the existing
cascade mutation after verifying a production snapshot with stored files.
The backup covers 4,838 evals and 4,763 output files. Post-deletion checks found
zero web runs and zero web leaderboard rows; all 3,374 other run documents were
unchanged. Shared eval source files remain intact. The web tab stays empty until
replacement full benchmark results are published.

## Remaining release work

1. The PR wires the dedicated Exa secret into web evaluation workflow steps.
   Reporting requires Actions on `main` and `ENABLE_CLIENT_WEB_PRODUCTION=true`;
   that repository variable is currently false. Local pilots retain
   `DISABLE_CONVEX_REPORTING=1`.
2. Review the PR and get Michael's approval before merging. The release workflow
   deploys the backend from `main`; never deploy production from this checkout.
3. Check the current minted benchmark against the runner fingerprint, including
   the scoring protocol change. Minting a new benchmark requires separate approval.
4. Start with a small manual production pilot. Inspect every tool request and
   result, persisted exact counts, trace artifacts, and Exa usage/cost accounting.
   Filtered pilots are not leaderboard results. Complete a full current benchmark
   run before checking its public leaderboard row.
5. Re-enable the web schedule only after the production pilot is reviewed.

## Rollback

Disable the web schedule and stop new web runs. Retain trace artifacts and the
pre-reset backup. Do not fall back automatically to server-side search: that would
reintroduce unobservable calls into the same experiment. Baseline runs remain
independent of this rollout.
