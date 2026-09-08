# Time-window grader correction

Eval: `002-queries/024-time_window_argument`

## Why this matters

The eval tests whether the model knows to accept a time argument for a reactive
Convex query. Reading the wall clock inside the query can leave expired items
visible because time passing does not rerun a subscription. The task deliberately
does not prescribe an argument name. This intent is explicit in
[issue #214](https://github.com/get-convex/convex-evals/issues/214) and
[PR #219](https://github.com/get-convex/convex-evals/pull/219).

All three audited Astra answers read `Date.now()` inside `listActive` and declare
no time argument. Those remain model failures against the intended measurement.

## Grader errors and fix

Two correct implementations passed the six API/data tests but failed the old
source check: a query builder assigned to a variable before `.take(100)`, and the
reference query alongside an unrelated mutation that reads the clock.

Replace the whole-file source walk with execution through the generated Convex
SDK in the existing WebAssembly sandbox. Check the consumed expiration-index
read, its caller-supplied strict lower bound, ascending order, native bound, and
returned document IDs. Trap clock reads before module loading and during query
execution, including imports, internal queries, and caught errors. Probe empty,
partial, and full result branches at three cutoffs. Deterministic date conversions
and uninvoked functions are allowed.

The sandbox implementation is extracted from eval 022 into `grader/`, preserving
its import restrictions, empty environment, absent host APIs, memory limit, and
worker lifecycle. No dependency, task, guideline, reference answer, schema, or
existing API/data assertion changes are needed.

The old blanket array-method bans are replaced by observing database operations:
an array method is not itself evidence of a database scan. Unbounded reads and
database filters still fail, and real-backend tests retain result validation.
This runtime probe covers representative paths; it is not an exhaustive proof
about every possible JavaScript branch or computation.

PR review found a bypass through `Date.prototype.constructor`. The clock trap
now also routes prototype/instance constructor access through the proxy and
replaces the underlying `now` method so property descriptors cannot expose it.
Four negative fixtures cover these paths; two positive fixtures preserve
constructor aliases and deterministic `Date.parse`/`Date.UTC` use.

Review also identified that valid bounded results may be re-fetched with
`db.get`. The probe now serves those synthetic documents for both supported
get signatures. Two positive fixtures cover the re-fetch, and a negative fixture
checks that re-fetching does not hide a clock read.

## Validation

- Both affected reference answers (022 and 024): 100% through `validateAnswers.ts`
  on disposable local backends.
- 39 time-window unit fixtures: 14 valid implementations accepted, 25 deliberately
  broken implementations rejected. These include both original false negatives,
  aliases/constants, local/imported/internal helpers, renamed time arguments,
  deterministic dates, clock reads in empty/full branches, caught clock errors,
  unbounded scans, unused indexed queries, and incorrect index ranges.
- Existing 31 bounded-query and sandbox tests pass after the extraction.
- Final full-pipeline regression run: all 42 cases reached the expected outcomes,
  with successful installation, deployment, TypeScript, and generated-code lint.
  All three archived Astra answers still score 1/7 (schema only). Direct sandbox
  replay additionally rejects each specifically for its `Date.now()` call.
- Repository tests: 297 runner/script/grader tests plus 50 evalScores tests pass.
  Repository typecheck and lint pass. The shared TypeScript helper passes targeted
  lint; both interpreter modules pass `node --check`. The repository's typed
  ESLint configuration does not support directly linting these `.mjs` files.

An earlier regression run stopped when a disposable backend failed its health
check. The final 42-case run completed without infrastructure failures.

All scoring used `DISABLE_CONVEX_REPORTING=1`; no fresh model generations,
production reporting, historical score changes, or benchmark minting occurred.

Local evidence: `/tmp/astra-audit/time-window-review-fixes-regressions/results.json`,
`/tmp/astra-audit/time-window-review-fixes-answers.log`,
`/tmp/astra-audit/time-window-astra-clock.log`, and
`/tmp/astra-audit/time-window-review-fixes-tests.log`. The disposable regression harness
is `/tmp/astra-audit/time-window-regressions.ts`.
