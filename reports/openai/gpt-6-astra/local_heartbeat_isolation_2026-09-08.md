# Heartbeat isolation task clarification

## Why this matters

The intended concept is keeping frequent presence updates separate from stable
user profiles. The old task explicitly allowed adding fields to `users`, but
three grader checks required a separate table. An archived Astra answer stored
`lastHeartbeatMs` on `users` and passed the online-status behavior checks. That
was not an unambiguous failure of the task as written.

The revised task explicitly names `userPresence`, requires `userId` and
`lastHeartbeatMs`, and requires stored user documents to remain unchanged.
Repeated pings must update the existing presence record independently for each
user. The threshold is explicitly inclusive; result ordering is unspecified.
This measures correct implementation of requested isolation, not spontaneous
selection of that design.

## Grader changes

- Inspect the deployed schema instead of matching schema source with a regex.
  Verify unchanged user fields, the existing `by_email` index, and required
  presence fields. Account for the backend's automatic `_creationTime` index
  suffix. Do not prescribe the presence index's name.
- Read `userPresence` directly instead of guessing the first non-users table.
- Check record identity, exact timestamps, repeat-ping idempotence, and each
  user's independence.
- Compare complete stored user documents after each heartbeat.
- Check complete online results at the inclusive cutoff, with a different
  window, after expiry, and for users who have never sent a heartbeat.

The reference answer already implements the requested schema and behavior and
was left unchanged. No runner or global guideline changes were needed.

## Validation

The canonical answer passed all five grader tests and the full local scoring
pipeline. `bun run typecheck` and `git diff --check` passed.

Fourteen fixture submissions were exercised through the actual grader and local
backend pipeline. All reached the grader with passing install, deployment,
typecheck, and lint steps in their final checks:

| Fixture | Expected result | Observed |
| --- | --- | --- |
| Canonical answer | Pass | Pass |
| Composed/aliased users validator | Pass | Pass |
| Different presence-index name | Pass | Pass |
| Extra profile field named `pingAt` | Fail schema check | Rejected |
| Heartbeat changes a profile name | Fail profile-isolation check | Rejected |
| Inserts a new presence row for every ping | Fail uniqueness check | Rejected |
| Deletes and recreates the presence row | Fail record-identity check | Rejected |
| Leaves an existing timestamp stale | Fail timestamp-update check | Rejected |
| Updates another user's presence | Fail independence check | Rejected |
| Uses an exclusive cutoff | Fail boundary check | Rejected |
| Ignores the requested time window | Fail multi-window check | Rejected |
| Returns the wrong heartbeat timestamp | Fail complete-result check | Rejected |
| Uses a different presence-table name | Fail declared-schema check | Rejected |
| Archived Astra answer storing heartbeats on users | Fail the clarified isolation contract | Rejected |

The alternative-index fixture initially hit a `bunx tsc` dependency-bootstrap
failure without a TypeScript diagnostic. Its grader passed even then. The
unchanged fixture passed every scoring step on a separate retry.

Fresh Astra smoke tests on the revised task:

| Condition | Result | OpenRouter generation |
| --- | --- | --- |
| `no_guidelines` | 100%, all five checks | `gen-1788832680-VAfKVFShcgv5Ot3q1gCc` |
| Default guidelines | 100%, all five checks | `gen-1788832681-x2w3qVmBEsM8lU2ZLDFu` |

These are one run per condition, not pass-rate or guideline-effect estimates.
Both generated answers used `userPresence`; the no-guidelines answer also used
an index on `lastHeartbeatMs` for the online query.

## Local evidence

- Reference: `/tmp/astra-audit/heartbeat-reference-final.log`
- Fixtures and harness: `/tmp/astra-audit/heartbeat-regressions/results.json`
  and `/tmp/astra-audit/heartbeat-regressions.ts`
- Alternative-index retry: `/tmp/astra-audit/heartbeat-regressions-retry/results.json`
- Model runs: `/tmp/astra-audit/heartbeat-astra-ng.log` and
  `/tmp/astra-audit/heartbeat-astra-default.log`

All runs used disposable local backends with reporting disabled. Historical
scores were not changed. Treat this as a changed task contract in the next
explicitly approved benchmark version.
