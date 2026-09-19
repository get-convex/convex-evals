# Decision benchmark release plan

This release adds multiple-choice Convex knowledge evaluations to the same
benchmark version as coding tasks. Existing `runs`, `evals` and `modelScores`
tables use the approved top-level `kind` union. There is no separate decision
version, provider discriminator or duplicated run table.

PR preparation and review do not authorize production deployment, migration,
benchmark minting or paid inference. Keep all release PRs as drafts until the
corresponding gates below are approved. Do not merge or enable auto-merge as
part of preparing them.

## PR order

1. **Compatible backend**, branch `codex/convex-decision-evals-release`, into
   `main`. It includes the accepted 106-question bank, runner, evidence package,
   union-aware consumers, optional historical coding tags and dedicated
   migration. New coding writes are tagged. Decision ingestion stays disabled.
2. **Strict backend**, branch `codex/convex-decision-evals-strict`, initially
   stacked on the compatible branch. Its implementation is exactly
   `docs/shared-kind-strict.patch`: required tags, kind-prefixed indexes,
   temporary compatibility removal and ingestion enabled. It must not merge
   until the compatible revision is deployed and the production audit passes.
3. **Website companion**, branch `codex/convex-decision-leaderboard` in
   `get-convex/website`. Merge into website `main` only after the strict backend
   is healthy. Website production activation follows its separate `main` to
   `prod` promotion. The coding model selector already depends on the new
   backend API, even before anyone opens the decision tab.

PR checks run for all target branches so the stacked strict change receives
tests before it is retargeted. When stage one lands, rebase the strict branch
onto the resulting `main`, retarget its PR to `main`, review the new diff and
require fresh checks for that exact head. Never merge the strict branch into
the compatibility branch as a shortcut. Do not run the patch manually in an
already patched strict checkout.

## Evidence already collected

The 19 September development rehearsal targeted only `brazen-pelican-414`.
It backed up and migrated 3,402 runs, 256,245 evals and 793 model scores. A full
comparison confirmed all 260,440 documents retained their original fields,
IDs and creation times except the intended `kind: "coding"` addition. The
complete relationship/tag audit passed before strict deployment.

There were 750 matched hosted coding query measurements, zero errors and
identical existing decoded results. The selected-model score response dropped
from 25,628 to 1,402 bytes. A real synthetic one-question ingestion and seeded
318/1,060-answer read cohorts passed source validation, deployed aggregation,
pagination and isolation. Chrome checks covered coding views, the old-version
decision empty state and both populated profiles. All synthetic rows, blobs
and the temporary helper were removed independently of the app checks.

The complete evals suite passed 741 tests, the strict backend passed 101 tests,
and website tests passed 37. Both backend typechecks, website typecheck/lint and
the 135-page website production build passed. Evals lint has 28 warnings and
zero errors. Source/patch hashes and the two approved schemas were checked.

These are development and local results, not a production capacity guarantee.
Hosted coding run-detail latency remained variable; the follow-up median was
860 ms for a 421 KB response. The current hosted coding history sample had
only two completed runs. Larger local histories are separate synthetic data.
All 106 questions have archived evidence; only five currently have supported
clean-checkout behavioral replay. CI verifies the archive and accepted bank,
not all historical option executions. See `decision-verification.md`.

## Production rollout gates

The commands below are an operator runbook, not commands executed during PR
preparation. Confirm team `convex`, project `evalscores` and production
`fabulous-panther-525` immediately before any production action. Retain logs
and backups in private release evidence, never in a public PR.

1. Obtain approval for the production rollout window. Record the starting
   backend/website revisions and existing model-run workflows. Pause new eval
   dispatches for the rollout and let in-flight paid runs finish. Do not cancel
   or duplicate paid work just to speed up deployment. Keep normal evaluation
   scheduling paused until the final shared version is minted and checked.
2. Export a production snapshot before writes and record its checksum, target,
   timestamp and table counts. Preserve any required storage backup separately
   according to the export options; a document export alone does not prove
   uploaded evidence blobs are backed up. Validate backup readability and the
   compatible restore procedure. Restoring is an incident action requiring
   separate approval, not an automatic rollback step.
3. Merge the compatible PR after green CI. `release.yml` on `main` creates a
   GitHub release and then deploys Convex. Wait for the **Deploy Convex** step
   and complete workflow to succeed for the exact merged SHA. A release tag or
   uploaded assets alone is not deployment success. Verify the production
   function contract, coding reads and disabled decision ingestion.
4. From the compatible checkout's `evalScores/` directory, run only the
   dedicated tag migration:

   ```sh
   bunx convex run migrations:runKindBackfill --prod
   bunx convex run --component migrations lib:getStatus --prod
   ```

   Wait until all three kind backfills complete. Do not run `migrations:runAll`,
   the production-to-dev sync script, a score rebuild or a local-run import.
   The dedicated migration writes only missing coding tags in batches of 25.
5. From the repository root, capture the complete audit:

   ```sh
   bun run scripts/auditDocumentKinds.ts --prod > production-kind-audit.json
   ```

   Require exit zero, every table complete, `safeToTighten: true`, no missing
   tags and no relationship errors. Audit pages are bounded at 100 documents
   and 2 MiB plus cached parent reads. Preserve all pages through `isDone`;
   one successful page is insufficient. Investigate failures and rerun the
   complete audit after repairs. Compare coding counts and representative
   benchmark/model outputs with the pre-migration evidence.
6. Retarget/rebase the strict PR as above. Check its schema against the
   approved final proposal and its diff against the reviewed strict patch.
   Record the passing production audit and approval before merging. Wait for
   the complete release workflow's strict deployment. Verify required tags,
   kind-prefixed query behavior, unchanged coding results and decision API
   availability on the deployed revision.
7. With explicit mint approval, dispatch **Mint Benchmark Version** from the
   final strict `main` revision. This mints one shared coding/decision identity
   and stores its source snapshot; it makes no provider calls. Record the
   version, source SHA, question count and archived snapshot. Do not mint the
   compatibility revision, silently attach a new bank to old results, or
   import local results. Recheck the source fingerprint before inference if
   benchmark inputs change after minting.
8. Release the website companion through its normal reviewed promotion and
   verify the actual production target, coding rankings/model history,
   benchmark selector and decision empty state for the newly minted version.
   Cached data is partitioned by backend URL. Old benchmark versions with no
   decision bank should show the explicit no-bank state.
9. Obtain separate approval for an initial paid decision run. Dispatch one
   model first, verify source/version/profile identity, evidence links,
   completed full-suite score and costs, then expand to the other models and
   approved guideline conditions. The workflow requests three repetitions,
   limits model-job concurrency to two, and retains journals. Its known-cost
   budget is not a hard dollar cap when a provider omits cost. Restore the
   previous coding workflow schedule only after the shared version is valid.

## Failure and rollback

- A failed compatible deployment stops the rollout before migration. Repair
  or redeploy the compatible union-aware revision through the normal release
  path; do not proceed based on the existence of a GitHub release.
- A failed migration or unsafe audit leaves the compatible schema in place
  and ingestion disabled. Resume the idempotent backfill or repair the exact
  audited defect; never infer readiness from migration status alone.
- If the strict deployment or subsequent smoke checks fail, stop new decision
  dispatches and keep the website promotion blocked. The supported fallback
  is the reviewed compatible union-aware code with ingestion disabled. It
  retains support for both tagged coding and any decision data already
  written. Do not restore the pre-union schema or delete tags/decision rows.
- A failed website promotion can roll back the website while leaving the
  backend union support intact. Pause new paid work until its evidence and
  result views are usable again.
- Do not automatically restore a snapshot, unmint a shared benchmark or rerun
  paid requests after an incident. Preserve existing records and journal IDs,
  then decide recovery from the actual failure and separately approved scope.

Release completion requires successful production gates and fresh results for
the shared minted version. Draft PRs, the development rehearsal and an
independent plan review alone are not production release completion.
