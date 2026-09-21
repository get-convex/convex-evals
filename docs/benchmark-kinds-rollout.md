# Coding and decision benchmark rollout

Decision questions now have their own benchmark identity within `benchmarkVersions`. Publishing them must not change the coding leaderboard's current version. Runs and scores keep their existing IDs and relationships.

## Release order

1. Keep this compatibility release separate from the strict-schema follow-up. Deploy compatibility through the existing `release.yml` workflow after approval. Do not deploy production from a laptop.
2. Record writer/workflow states, pause relevant mint and ingestion jobs, and confirm none are active. Previously disabled coding schedules must stay disabled.
3. Export all `benchmarkVersions`, `runs`, and `modelScores` documents privately. Confirm exports are complete. Run `bun scripts/benchmarkKindDryRun.ts <versions.json> <runs.json> <scores.json> <private-output-directory>` and review the full before/after manifest.
4. After indexes are ready, exhaust every page of `benchmarkKindMigration:dryRun`. Compare it with the reviewed offline manifest. Stop for differences, unknown shared hashes, duplicates, or mixed-kind references.
5. Invoke `benchmarkKindMigration:applyOne` for each reviewed entry using its exact ID, before, and after documents. It rejects changed preconditions and supports idempotent retries.
6. Exhaust `benchmarkKindMigration:audit` for all three tables. Require zero missing kinds and relationship errors. Compare all run/score documents against the baseline and all benchmark documents against the manifest. Do not recompute scores.
7. Deploy the strict-schema follow-up only after those checks pass. Verify both public leaderboards, archived source digest, run/question evidence, version selectors, and deep links. Restore only previously enabled writers.

No new benchmark mint or paid evaluation is part of this rollout. The future `decision_v1` runner will require an explicitly minted new-format version before inference; it must not alias its computed hash to the old release. Existing legacy runs remain readable and valid.

## Identities retained

- Coding: `41d65c9b4f5bcdb97bc5c6ead5aa054e335b2eab6abc897b352b97b98b016fb3`, 112 evals, existing September 10 date.
- Decision: `91852c9a25a98f75dcac6f6219d93e8c49f6caa5b2b6e12012ecb58ccffae522`, 90 sources / 106 questions, existing September 20 date, `legacy_shared_v4` format.
- The decision document links to the existing coding document. IDs, source evidence, run outcomes, costs, and score values remain unchanged.

Coding protocol 3 accidentally included nine tracked runtime files. The frozen contributions in `runner/benchmarkLegacyRuntime.ts` reproduce its published hash without making future local runtime output part of the identity. They are compatibility constants, not current benchmark inputs.

## September 21 rehearsal evidence

- Read-only production snapshot: 16 benchmarks, 3,406 runs, 797 scores; 15 coding and one decision benchmark. Zero classification/reference errors.
- Full snapshot migration rehearsal through real mutation/query handlers: all runs/scores preserved exactly, benchmark documents matched the manifest, retries were no-ops, exhaustive audits passed.
- This optional rehearsal disables convex-test schema validation only to retain opaque production storage/model IDs. Native fixture migration tests separately validate the schema branches and migration behavior.
- Development `brazen-pelican-414`: 15 existing coding benchmarks migrated. All 3,402 runs and 793 scores audited with zero missing kinds or relationship errors. Its default coding query returns the original current hash and 19 scored models.
- The actual archived legacy source was downloaded and digest-checked, then accepted unchanged by the updated validator.
- Production has not been changed by these rehearsals. Refresh the production snapshot and verify writer quiescence at rollout time; this evidence is not a substitute for that gate.

Run the private-snapshot rehearsal with `BENCHMARK_REHEARSAL_SNAPSHOT_PREFIX=/path/to/snapshot-prefix bun run --cwd evalScores test:once convex/benchmarkKindProductionRehearsal.test.ts`. Inputs are `<prefix>-versions.json`, `<prefix>-runs.json`, and `<prefix>-scores.json`; no private snapshots belong in Git.

## Rollback

Pause writers. Restore the compatible deployment before reversing document shapes. Reverse only the reviewed benchmark field changes from the manifest; never restore a whole database over newer runs. Preserve both old and kind-scoped indexes during the rollback window. If new-format benchmarks were created after rollout, stop and build a targeted rollback plan rather than downgrading them.
