# Shared query-probe review

Review date: 2026-09-09. This decision record covers the reviewed correction
batch on `codex/platform-env-grader`. It supersedes the earlier platform-env
readiness statement. At completion of this review, no commit, push, benchmark
mint, schema edit, or hosted deployment had been performed for this batch.

## Why the earlier checks were insufficient

The platform-env grader needed to recognize executed typed environment reads,
including aliases and imported helpers. Its replacement used a shared QuickJS
probe. That removed several source-matching mistakes but introduced a different
problem: valid Convex code could fail because the substitute runtime lacked
ordinary Convex APIs. A passing reference answer and many matching fixtures did
not establish compatibility with other valid implementations.

An independent Fable review through the real Claude CLI challenged that claim.
A correct URL-normalizing answer passed the live backend checks but failed the
probe because `URL` was unavailable. We withdrew readiness and reviewed all five
consumers of the shared runner, plus the scoring and task-contract boundaries.

## Review method

Three independent agents reviewed runtime compatibility, task contracts, and
scoring integrity. Reviewers then crossed into code they had not authored.
Fable (`claude-fable-5-1`, invoked with `claude -p --model fable`) performed
multiple independent review rounds and ran its own local-backend probes. Findings were
reproduced or checked against implementation evidence before acceptance.

Controls include different valid implementations, deliberately broken
implementations, original counterexamples, real Convex deployment and scorer
runs, and failures of the grader itself. Local runs disable Convex reporting.
No fresh benchmark model generation was needed, and saved model outputs were
not edited to manufacture passes. AI grading remains disabled.

## Root corrections

| Area                                      | Problem                                                                                                                                                   | Correction and intended claim                                                                                                                                                                        |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared execution                          | A substitute JavaScript runtime rejected native URL, encoding, console, and SDK behavior.                                                                 | Run the instrumented query in the local Convex backend's native runtime. Remove the QuickJS worker and dependency.                                                                                   |
| Convex values                             | Parsing SDK results as ordinary JSON, or JSON-stringifying a decoded diagnostic, rejected valid extra bigint, special-float and byte fields.              | Decode and encode at the SDK's documented value boundaries using its own codecs; format the assertion diagnostic with Node's `inspect`.                                                              |
| Grader errors                             | An unsupported probe or broken Vitest execution could become an ordinary failed test and lower a model's score.                                           | Record trusted infrastructure events separately; validate Vitest completion, report counts, process status, and unhandled errors. Abort scoring when the grader cannot produce a trustworthy result. |
| Concurrent runs                           | A fatal scoring error could return before already-started work finished, restoring shared reporting context too early.                                    | Stop claiming new work, drain started work, then fail the run and restore context.                                                                                                                   |
| Validator module scoring                  | Candidate exceptions in a beforeAll hook skipped all six assertions, which the stricter scorer could only recognize as an incomplete grader run.          | Evaluate candidate code inside assertions and cache either the result or error. Keep all six assertions and the execution budget; genuine module failures receive an ordinary zero Tests score.      |
| `022-unbounded_query_no_collect`          | The probe omitted valid point re-fetches and native globals.                                                                                              | Support re-fetching the actual synthetic rows that a bounded read issued. Preserve the previously agreed native bounded-API selection claim.                                                         |
| `024-time_window_argument`                | The task omitted the caller-time requirement, and the probe also imposed unrelated read/index mechanisms.                                                 | Explicitly request a caller-supplied timestamp. Use real database reads and observe clock use separately. Accept behaviorally correct filtering, iteration and pagination alternatives.              |
| `006-typed_env` / `009-platform_env_urls` | Source matching, exact return-key sets and restricted helper APIs rejected valid equivalents; defaults-only checks could accept fabricated configuration. | Check configured values and generated types, instrument actual value reads, allow extra return fields/public helpers, and specify absent versus empty string behavior.                               |
| `008-nested_transaction_limits`           | Opaque native function handles were missing from the probe's supported operations.                                                                        | Resolve handles through the native SDK syscall and observe the executed child's identity, arguments and budget. Retain real rollback tests.                                                          |

The time-window wording is a proposed clarification in this reviewable diff.
It measures implementation of a requested caller-time contract, not spontaneous
selection of that strategy. The bounded-listing selection contract is unchanged.
Complete pagination and cascade-delete contract work remain separate.

## Counterexamples and corrections

| Case                                                                        | Earlier result                                                    | Corrected result / interpretation                                                                                              |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Platform URLs normalized with native `URL`                                  | Live behavior passed; probe rejected `URL` as undefined.          | Native runtime supports the same implementation.                                                                               |
| Bounded rows re-fetched by ID                                               | 5/6 despite equivalent returned documents.                        | 6/6 through the full scorer.                                                                                                   |
| Time-window query using native pagination                                   | Probe rejected a valid operation.                                 | 7/7 through the full scorer.                                                                                                   |
| Child called through a native function handle                               | 7/8 despite a valid native budget.                                | 8/8 through the full scorer.                                                                                                   |
| Typed env helper with console timing                                        | Runtime incompatibility caused a false failure.                   | Full scorer accepts the valid implementation.                                                                                  |
| Extra configuration fields or public helpers                                | Exact-shape matching rejected harmless additions.                 | Required fields/functions remain checked; additions pass.                                                                      |
| Missing declarations, wrong arguments, fabricated config or raw value reads | These are task/model failures.                                    | They still fail the relevant checks.                                                                                           |
| `Temporal.Now.instant()` in caller-time query                               | Date-only instrumentation falsely passed 7/7.                     | The expanded clock check rejects the read while the six behavior tests still pass.                                             |
| Candidate exhausts pages until native timeout/OOM                           | The new infrastructure handling initially aborted the entire run. | Independent reviews identified this as a blocking classification defect; final correction and verification are recorded below. |

Clock checks cover Date reads, Temporal.Now time methods, Intl formatting that
defaults to the current date, and performance epoch-time access. Explicit dates
and duration-only measurements are positive controls. Same-project query helpers
remain instrumented, and caught prohibited reads still fail.

## Isolation and score boundaries

The probe connects only to the already-running local backend. Candidate code
runs inside Convex, without Node's host filesystem, process or credentials.
Imports are restricted to candidate source/dependencies and trusted probe files;
host modules are never executed by Node. Network fetch is rejected by the query
runtime.

The one-off endpoint uses an **uncommitted transaction**. It does not reject
every low-level write: direct insert and scheduler syscalls can return IDs and
be visible inside that transaction. Independent persistence checks verified
that documents and scheduled work were absent afterward, including repeated
polls, and the backend source confirms no transaction commit. This distinction
is intentional in the review record rather than calling every syscall readonly.

An infrastructure failure fails the parent run, preserving the existing rule
that failed runs are excluded from aggregates. Diagnostics retain the cause
without awarding a Tests score. Individual in-progress eval rows may remain
under that failed parent; no backend schema change is included. This increases
the cost of a flaky grader from one eval to the run, so genuine candidate
execution failures must remain ordinary test failures.

Native execution failures use trusted phase records, rather than candidate error
messages. The wrapper records candidate execution start, result completion, and
unsupported operations through the captured native logger with unpredictable
per-probe identifiers. A resource failure during candidate execution is a normal
test failure. A failure before execution, after result completion, or after an
unsupported operation is infrastructure. This cannot prove trusted inspector
code has no bugs during execution; independent controls remain necessary.

Native console overflow can discard the completion record. An application error
with that native overflow record is conservatively unscored because attribution
is unavailable; a successful noisy answer still passes. We do not claim complete
resource-failure attribution after provenance is lost. Candidate messages cannot
supply either a valid phase identifier or the backend's overflow record.

The command deadline also covers stdout/stderr draining, not just the process
leader. A reproduced early-exit descendant held inherited pipes past a 100 ms
deadline for roughly two seconds. The corrected helper bounds the whole command
and kills the owned POSIX process group even if the leader has already exited.
Windows retains its existing process-kill fallback; no POSIX-group equivalent is
claimed there. Descendants that escape into a separate process session are also
outside the process-group cleanup guarantee.

The bounded-listing inspector still does not resolve native function handles.
That path remains an explicit compatibility limitation of that inspector, rather
than evidence that an otherwise-correct handle-based implementation is wrong.

The local scorer protocol version changes from 1 to 2 because shared scoring
semantics change. This is not a benchmark mint. Publishing a new benchmark
version requires explicit approval after review.

## Validation and remaining review

Earlier verification, retained to show the sequence of independent checks:

- All five reference answers passed the complete local pipeline at 100%.
- The full repository suites passed: 473 runner/script tests and 54 backend tests.
- The env contract matrix matched all 23 complete pipeline cases: 13 valid and
  10 invalid, with installation, deployment, TypeScript and lint prerequisites
  passing. Its integration fixture suite passed 82 cases.
- The time-window matrix matched all 64 complete pipeline cases: 24 valid and
  40 invalid. Four lint-only fixture corrections were rechecked explicitly;
  the consolidated record retains both original and corrected evidence. The
  final clock integration suite passed all 64 cases.
- Scoring/report/queue checks passed 72 targeted tests, including actual Vitest
  process failures and draining concurrent work under the correct context.
- The validator module reference still passed 6/6 through the real scorer;
  candidate exceptions, VM timeouts and a wrong SDK pin each scored 0/6, without
  infrastructure aborts. Three durable scorer regressions cover reference,
  exception and timeout behavior. A separate actual-process control keeps an
  unavailable Node executable classified as infrastructure.
- Fable independently ran 258 tests and a TypeScript check, reproduced the
  candidate-resource classification bug, and returned **HOLD** pending its fix.

Fable's third, broad review returned SHIP WITH NONBLOCKING NOTES. We reopened
the freeze for one demonstrated encoding issue described below before final
acceptance. Its earlier second review had observed concurrent edits, recorded
file hashes, and explicitly did not certify that later tree.

## Verification before the codec follow-up

- `bun run test`: 543 runner/script tests and 54 backend tests passed (597 total).
- `bun run typecheck`: root, evalScores backend and visualizer passed.
- All six affected reference answers passed the complete scorer at 100%, including
  validator composition alongside the five shared query-probe consumers.
- The final env compatibility matrix matched 22 additional complete pipeline
  cases: eight valid, fourteen invalid. The two snapshot-option negatives also
  fail TypeScript; they are documented separately and are not claimed to be
  valid alternatives. All 102 env integration fixtures passed.
- Final execution-phase tests passed 71 cases, covering all five missing-module
  contracts, unexpected trusted preludes, candidate loops/OOM, caught unsupported
  errors followed by resource exhaustion, log overflow and forged messages.
- Replaying the three unchanged archived Astra platform-env answers still produced
  deployment failures. Their invented APIs remain genuine model errors.
- The repository lint command passed with its existing warning. Expanded lint
  also checks files outside that command's normal coverage; its baseline
  comparison found 22 remaining errors in three files, all present in an archived
  copy of the original HEAD (which had 24). They concern pre-existing API-spec
  `any` types and Bun assertion typings; this batch does not claim that broader
  sweep is clean. Raw original/current lint logs are retained.
- JavaScript inspector lint and changed-file formatting checks passed.

Fable's third independent verdict was **SHIP WITH NONBLOCKING NOTES**, after
310 independently run tests and nine custom backend probes. Functional code was
frozen before that review. Two test-harness TypeScript annotations were then cleaned up without
changing runtime behavior, and typecheck was rerun; inspected-file hashes retain
that distinction. No readiness claim is based solely on these passing counts.

## Encoding follow-up from the final review

Fable reproduced a remaining value-encoding problem: the SDK's invoke methods
return Convex-encoded JSON. Parsing that as ordinary JSON and returning the
encoded object through Convex again double-encoded bigint, special floats and
bytes. This could reject otherwise valid extra fields in an env result.

The correction uses the candidate-installed SDK's own `jsonToConvex` and
`convexToJson` functions. Each inspector decodes an invoked function's result;
intercepted nested calls encode it again before handing it back to the SDK.
Nested call arguments already arrive encoded and are left in that form. The
native outer result transport and conservative overflow rules are unchanged.
This fixes the value boundary, rather than special-casing a few field values.

All five consumers were updated. The first combined native run after the fix
passed 277 tests, including query/mutation results, nested query replies,
special nested arguments and the existing isolation/attribution controls.

The complete scorer then exposed a second, adjacent issue: the platform-env
assertion eagerly used `JSON.stringify(result)` as its diagnostic message. A
valid extra bigint threw even when the required-field comparison returned true.
Using Node's `inspect` formats native Convex values safely. A separate reviewer
reproduced that crash and verified both a valid result and a wrong required field.

Final combined checks after those corrections:

- `bun run test`: 554 runner/script tests and 54 backend tests passed (608 total).
- All six affected reference answers passed the complete local scorer at 100%.
- Root, backend and visualizer typechecks passed. The repository lint command
  passed with one existing warning; the broader pre-existing lint limits above
  remain unchanged. The corrected diagnostic also passed targeted lint.
- All 110 native env integration tests passed, including exact bigint, NaN,
  negative-zero and ArrayBuffer preservation assertions.
- All eight new complete-pipeline env cases matched: six valid direct/helper/
  native-handle answers passed every stage, while two caught raw-read answers
  failed only the intended provenance test (typed env 3/4, platform env 4/5).
- Changed-file formatting and `git diff --check` passed. Functional source
  hashes matched throughout this final combined run.

A fourth, focused Fable review also returned **SHIP WITH NONBLOCKING NOTES**.
It independently ran ten backend probes, three complete scorer cases, the
35-test sandbox suite and a root TypeScript check. It reproduced special values
in direct results, nested arguments and nested replies; invalid Convex values,
caught raw reads and helper exceptions remained candidate failures. The
post-completion infrastructure controls also retained their intended result.

That review observed the diagnostic fix landing during its run. Its subsequent
scorer checks used the corrected file. Root verified the identical grader hash
(`cd3b43b9...`) in the final 608-test run, all six references and the eight-case
fixture recheck. The failed earlier platform-env fixture run is retained only
as counterexample evidence, not cited as a passing run. Functional files matched
Fable's ending hashes; only this decision document changed afterward.

The remaining notes do not require further changes in this batch: the nested
codec roundtrip is lossless but does two avoidable conversions, and the native
overflow, trusted-inspector attribution, bounded-listing handle and process
cleanup limits above remain. This is readiness for human review of the diff,
not a claim that every possible implementation has been proved correct.

## Evidence locations

The disposable local evidence lives under `/tmp/astra-audit/`; these paths are
not portable CI artifacts. The important conclusions and counts are retained
above so the decision record does not depend on those files surviving.

- Initial independent review: `fable-platform-review/review.md`.
- Root URL counterexample: `primary-platform-url-counterexample/`.
- Runtime review: `shared-runtime-independent/review.md` and
  `shared-runtime-independent/time-final-verified-results.json`.
- Contract review: `contract-independent/implementation.md` and
  `contract-independent/implementation-verified-results.json`.
- Cross-review persistence proof: `native-cross-review/persistence/results.json`.
- Scoring review: `scoring-boundary-independent/review.md` and
  `scoring-boundary-independent/native-application-errors.json`.
- Second Fable review: `fable-native-review/review.md`, with its own probe
  scripts, result JSON, event stream and inspected-file hashes.
- Combined tests: `native-review-full-tests-first.log` and final
  `final-verification/tests.log`.
- Reference answers: `native-five-reference-validation.log`.
- Final reference, typecheck, lint and archived-output checks:
  `final-verification/`, with source hashes and raw command logs.
- Broad Fable review: `fable-final-review/review.md` and its independent probes.
- Codec fixtures: `shared-runtime-independent/env-codec-review.md` and
  `shared-runtime-independent/env-codec-verified-results.json`.
- Final combined checks after codec changes: `final-verification/*-post-codec.log`.
- Focused Fable codec review: `fable-codec-review/`.
- Validator setup-hook counterexample and correction:
  `validator-hook-attribution/{before,after}-results.json`.

These are evidence for the reviewed cases and code paths, not a guarantee that
every task, branch, input or deliberate grader escape is correct. The intended
outcome is defensible scoring with explicit limits, not a higher Astra score.

The focused Fable report's prose clock headings are inaccurate. Its actual
snapshot timestamp files record 12:32:24 to 12:39:00 AWST; use those files, the
CLI event stream and content hashes for chronology, not the report headings.
