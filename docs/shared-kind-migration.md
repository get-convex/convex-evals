# Shared document kind migration

The shared `runs`, `evals`, and `modelScores` tables now use top-level
`kind` tags to separate coding and decision records. The rollout must happen
in stages because existing coding documents predate the discriminator.

## 1. Compatible deployment

Deploy the compatibility schema and union-aware consumers first. During this
stage, the coding branch accepts an omitted `kind` for historical records, but
new coding writers always write `kind: "coding"`. Decision records require
`kind: "decision"` and are not enabled for ingestion until the strict stage.

Keep existing coding behavior and indexes compatible while consumers narrow
the branch before reading coding-only fields. A missing `kind` is historical
coding data, not evidence of a new document type.

Deploy this backend before the updated website. The website model page now
passes a model selector to `runs:leaderboardScores`; the compatible backend
already accepts it, while the pre-change backend does not.

## 2. Dedicated tag-only migration

Run the dedicated `migrations:runKindBackfill` sequence after the compatible
deployment. It processes `runs`, `evals`, and `modelScores` in bounded,
resumable batches and changes only the missing discriminator to
`kind: "coding"`. It must not copy or delete records, change IDs or creation
times, rewrite benchmark references, recompute scores, or run model calls.

The migration is separate from `runAll` so unrelated historical repairs cannot
be mixed into this rollout. Re-running a completed batch is safe because
already tagged records are no-ops.

## 3. Exhaustive audit

Run `bun run scripts/auditDocumentKinds.ts` against development first, then
use `--prod` only when the compatible production deployment and migration are
ready. The script invokes the internal read-only
`migrations:auditDocumentKinds` query through the installed Convex CLI. It
consumes every page of all three tables, detects malformed responses and
repeated cursors, and emits aggregate JSON.

Audit pages are capped at 100 documents and 2 MiB of page reads, leaving room
for relationship checks on large historical records. The audit uses each paged
document directly and shares parent lookups within the page. A byte-limited
page may contain fewer than 100 records; follow its cursor until `isDone`.

The audit must report every table complete, with zero missing tags and zero
relationship errors. Relationship checks cover coding and decision parent
runs, benchmark references, and score latest-run identity. The script exits
nonzero when the audit is incomplete or unsafe. Do not treat migration task
completion alone as proof that the schema is ready.

Save the audit output with the release evidence. Investigate every missing tag
or relationship error and rerun the complete audit after remediation. Do not
start paid evals, import local runs, or apply the strict schema while the audit
is unsafe.

## 4. Separately deployed strict patch

After the audit proves readiness, deploy the strict schema revision separately.
Require `kind: "coding"` and `kind: "decision"` on both branches, switch coding
reads to the kind-prefixed indexes described by the schema diff, and remove
only the replaced compatibility indexes. Keep union-aware exhaustive dispatch
in shared lifecycle, maintenance, deletion, and scoring paths.

The complete second-stage change is checked in as `docs/shared-kind-strict.patch`.
From the repository root, after saving a successful migration audit:

```sh
git apply --check docs/shared-kind-strict.patch
git apply docs/shared-kind-strict.patch
bun run typecheck
bun run test
```

The patch requires the approved tags, removes the replaced indexes and temporary
normalizers/backfills, updates coding queries and fixtures, and enables the
decision ingestion gate. Keep this as a separate revision and deployment after
the compatibility revision and completed migration. If subsequent source edits
make the patch fail its check, regenerate and review the affected hunks rather
than applying it with rejected hunks or leaving only part of the strict change.

Verify the strict deployment and website/API contract before dispatching hosted
decision runs or minting the final shared version. The migration preserves old data and shared IDs, and the
strict deployment must preserve both coding history and any decision records
already written. Rollback planning must retain support for tagged documents;
the pre-change schema is not a safe rollback target.

Convex snapshot export/import preserves every document field, including
`kind`. A snapshot can be imported into a strict deployment only when its
source passed the complete post-migration audit. An older snapshot containing
untagged coding rows must first be imported under the compatible schema, run
through the tag-only migration and audit, then exported again. Do not strip or
invent tags in the snapshot sync script.
