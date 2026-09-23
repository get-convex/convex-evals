# Decision benchmark release plan

This document records the original September 19 rollout. Its shared benchmark
version design was superseded by the [benchmark kind rollout](benchmark-kinds-rollout.md).
For the reviewed 108-question update, use the [September 23 promotion notes](decision-bank-2026-09-23.md).
The counts and gates below describe the original rollout, not a new migration requirement.

This release adds multiple-choice Convex knowledge evaluations to the same
benchmark version as coding tasks. Existing `runs`, `evals` and `modelScores`
tables use the approved top-level `kind` union. There is no separate decision
version, provider discriminator or duplicated run table.

PR preparation and review do not authorize production deployment, migration,
benchmark minting or paid inference. Keep all release PRs as drafts until the
corresponding gates below are approved. Do not merge or enable auto-merge as
part of preparing them.

## PR order

1. **[Compatible backend PR #323](https://github.com/get-convex/convex-evals/pull/323)**,
   branch `codex/convex-decision-evals-release`, into
   `main`. It includes the accepted 106-question bank, runner, evidence package,
   union-aware consumers, optional historical coding tags and dedicated
   migration. New coding writes are tagged. Decision ingestion stays disabled.
2. **[Strict backend PR #324](https://github.com/get-convex/convex-evals/pull/324)**,
   branch `codex/convex-decision-evals-strict`, initially
   stacked on the compatible branch. Its implementation is exactly
   `docs/shared-kind-strict.patch`: required tags, kind-prefixed indexes,
   temporary compatibility removal and ingestion enabled. It must not merge
   until the compatible revision is deployed and the production audit passes.
3. **[Website companion PR #1019](https://github.com/get-convex/website/pull/1019)**,
   branch `codex/convex-decision-leaderboard` in
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

Keep stage two in draft throughout migration. Deleting the merged stage-one
branch can automatically retarget it; retargeting alone does not rerun CI.
The rebase/push must produce fresh checks before it is made ready for approval.
Freeze unrelated backend merges during the rollout window. The release workflow
serializes deploy jobs without cancelling an in-flight deployment, but that
does not replace these per-stage gates.

## Evidence already collected

The 19 September development rehearsal targeted only `brazen-pelican-414`.
It backed up and migrated 3,402 runs, 256,245 evals and 793 model scores. A full
comparison confirmed all 260,440 documents retained their original fields,
IDs and creation times except the intended `kind: "coding"` addition. The
complete relationship/tag audit passed before strict deployment.
The tag migration took about 14 minutes, the full preservation comparison about
6 minutes, and the successful audit about 14 minutes. These are development
measurements, not production timeouts or duration promises.

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
   Record the live `Periodic Evaluations` workflow state, and disable it for
   the approved window only if it is active. A workflow already disabled before
   the rollout must stay disabled afterward. This is an operational GitHub
   Actions gate, not a switch enforced by repository code. Also hold manual
   coding and guideline-validation dispatches. Without this hold, the stage-one
   hash goes into the non-public unminted bucket: coding inference still spends
   money and advances model scheduling even though it does not populate the
   published benchmark.
   The approval names a release operator who owns both the hold and restoration.
   Before the window, record each of these workflows' current state with
   `gh api repos/get-convex/convex-evals/actions/workflows/<filename>`:
   `periodic_evals.yml`, `manual_evals.yml`, `validate_guidelines.yml`, and
   `decision_evals.yml` once it exists on `main`. During the approved window,
   disable each active workflow explicitly, for example:

   ```sh
   gh workflow disable periodic_evals.yml --repo get-convex/convex-evals
   gh workflow disable manual_evals.yml --repo get-convex/convex-evals
   gh workflow disable validate_guidelines.yml --repo get-convex/convex-evals
   ```

   Disable the new decision workflow after stage one introduces it, and hold
   dispatch permission until then. Disabling does not cancel existing runs.
   Check queued, waiting and running jobs, including caller-dispatched branch
   runs; wait for them to finish before continuing. The same operator restores
   only previously active workflows after all gates pass. A separately approved
   decision pilot requires explicitly enabling its new manual workflow.
2. Export a production snapshot before writes and record its checksum, target,
   timestamp and table counts. Preserve any required storage backup separately
   with `bunx convex export --prod --include-file-storage --path <private.zip>`
   from `evalScores/`; the explicit flag includes uploaded evidence files.
   Validate the archive and record the file-storage contents. The development
   pass checked backup readability and document preservation, but did not
   rehearse an import. Before approving the production window, rehearse restore
   into an isolated empty local/nonproduction deployment under the compatible
   schema, and verify counts, IDs, references and representative blob reads.
   Never use the existing development or production deployment as the restore
   test target. Restoring production is an incident action requiring separate
   approval, not an automatic rollback step.
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
   bun run scripts/auditDocumentKinds.ts --prod > /private/release-evidence/production-kind-audit.json
   ```

   Require exit zero, every table complete, `safeToTighten: true`, no missing
   tags and no relationship errors. Audit pages are bounded at 100 documents
   and 2 MiB plus cached parent reads. Preserve all pages through `isDone`;
   one successful page is insufficient. Investigate failures and rerun the
   complete audit after repairs. Compare coding counts and representative
   benchmark/model outputs with the pre-migration evidence. Replace the example
   output path with the operator's private release directory outside the checkout.
6. Retarget/rebase the strict PR as above. Check its schema against the
   approved final proposal and its diff against the reviewed strict patch.
   Record the passing production audit and approval before merging. Wait for
   the complete release workflow's strict deployment. Verify required tags,
   kind-prefixed query behavior, unchanged coding results and decision API
   availability on the deployed revision.
   Convex also validates the strict schema against live documents. If an
   untagged row appears after the audit, schema deployment fails and the
   compatible deployment stays active. Treat that as a stopped gate: repair
   and repeat the audit, not permission to bypass schema validation. The earlier
   GitHub release may still exist despite that failed deploy.
7. With explicit mint approval, dispatch **Mint Benchmark Version** from the
   final strict `main` revision. This mints one shared coding/decision identity
   and stores its source snapshot; it makes no provider calls. Record the
   version, source SHA, question count and archived snapshot. Do not mint the
   compatibility revision, silently attach a new bank to old results, or
   import local results. Recheck the source fingerprint before inference if
   benchmark inputs change after minting.
   Approval of this gate must acknowledge the conservative identity policy
   below. Mint only once for the chosen final source; an exact idempotent retry
   must use that same source. An accidental compatibility-stage mint fails
   after source upload, so do not use it as a preflight check.
8. Release the website companion through its normal reviewed promotion and
   verify the actual production target, coding rankings/model history,
   benchmark selector and decision empty state for the newly minted version.
   Cached data is partitioned by backend URL. Old benchmark versions with no
   decision bank should show the explicit no-bank state.
   The proposed rollout deliberately allows an initially empty new coding and
   decision cohort. Historical versions and their results remain selectable.
   Accept that behavior explicitly at release approval; do not announce a
   populated leaderboard until hosted runs have completed. This plan does not
   imply permission to spend money just to fill the empty state.
9. Obtain separate approval for an initial paid decision run. Dispatch one
   model first, verify source/version/profile identity, evidence links,
   completed full-suite score and costs, then expand to the other models and
   approved guideline conditions. The workflow requests three repetitions,
   limits model-job concurrency to two, and retains journals. Its known-cost
   budget is not a hard dollar cap when a provider omits cost. Restore only
   workflow schedules that were active before the rollout, and only after the
   shared version is valid. Do not enable a previously disabled workflow without
   separate approval. Minting does not populate scores; historical versions
   remain selectable while the new cohort is empty.
   Set the workflow input to a single model, for example `model=jev` with
   `condition=no_guidelines`; its current default is `all`, so do not accept the
   UI default for the pilot. `runDecisions` awaits the hosted `onStart` hook
   before entering its provider loop (`runner/decisions/run.ts`); a disabled
   ingestion gate or missing minted definition rejects before paid inference.

## Identity policy to approve before minting

This release retains the reviewed conservative hash inputs. They include
decision request/scoring code and operational backend files such as
`decisionConfig.ts`, `decisionAdmin.ts`, `decisionStorage.ts` and
`decisionIngestionPerformance.ts`. A change to a hashed input changes the
shared benchmark identity, even if it only adjusts a batch size or evidence
limit. That does not automatically mint anything: new coding runs otherwise
enter the unminted bucket, and decision start requires the corresponding
approved minted definition. Plan such changes as a new shared benchmark or
defer them; do not silently compare them with the prior version.

The minted shared metadata, including the curated-model snapshot, is immutable.
An attempt to remint the same version with changed curated models is rejected.
That snapshot describes the model roster at mint time; it is not an admission
allowlist. Adding a coding model later can still schedule, score and display it
under the same version, while historical curated-cohort progress keeps its
original denominator. Do not remint just to refresh that snapshot. Later
documentation or model-roster commits may also run decisions under an unchanged
shared hash: the stored minted source remains the authority, and the run records
its own origin commit separately. A later remint with different source provenance
is not an idempotent retry even if its benchmark hash is unchanged.
The first mint approval must explicitly accept this policy. If a narrower
semantic hash or editable curated snapshot is preferred, stop before minting
and review that change separately rather than modifying the accepted schema
or mutating an existing version during the rollout.

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
  Deploy that fallback through a new reviewed revert PR into `main` which
  reverts the strict implementation commit while preserving the compatible
  commit. Wait for its release workflow's successful Convex deployment and
  verify disabled ingestion. Do not manually deploy an old checkout with a
  production key. Freeze other merges until the rollback lands and is verified,
  since any intervening `main` release would otherwise redeploy strict code.
- A failed website promotion can roll back the website while leaving the
  backend union support intact. Pause new paid work until its evidence and
  result views are usable again.
- Do not automatically restore a snapshot, unmint a shared benchmark or rerun
  paid requests after an incident. Preserve existing records and journal IDs,
  then decide recovery from the actual failure and separately approved scope.

Release completion requires successful production gates and fresh results for
the shared minted version. Draft PRs, the development rehearsal and an
independent plan review alone are not production release completion.
