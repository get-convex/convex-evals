# Bounded query grader correction

Eval: `002-queries/022-unbounded_query_no_collect`

## Decision

Keep the task neutral and preserve the original measurement: does the model
choose a bounded database read for a plain listing request? The supplied
guidelines explicitly recommend that default. Without guidelines, using
`.collect()` remains a failure to demonstrate the desired best practice.

Remove the unstated requirements to return exactly 100 entries and order them
newest first. Keep schema, argument, workspace, empty-result, and document
correctness checks. Permit internal helpers and ignore return validators.

## Change

The old source check rejected any `.collect()` call anywhere in `convex/index.ts`.
The new probe invokes only the target query through the generated project's real
Convex SDK, observes the native reads it consumes, and checks that returned IDs
come from bounded reads. It follows ordinary imports and internal queries through
execution. A limit constant, alias, helper, or unrelated `collect` method does not
change the result.

PR review caught an unsafe assumption in the initial probe: clearing a Bun
subprocess's environment did not prevent generated code from reading host files.
The final implementation statically bundles allowed source and dependencies, then
executes them exclusively in a QuickJS WebAssembly interpreter with no host APIs.
Each probe uses a disposable worker, memory and execution limits, and an empty
SDK environment. The parent terminates the worker after every result, avoiding
an interpreter cleanup failure observed after async heap exhaustion.

The probe accepts positive finite native stream limits and pagination page sizes.
It does not prove arbitrary JavaScript loop termination or worst-case rows/bytes
scanned. Real-backend tests, rather than the synthetic probe, check database
semantics and returned documents. Complete traversal and batching coverage is
tracked in [issue #286](https://github.com/get-convex/convex-evals/issues/286).

The task, guidelines, reference answer, and application schemas are unchanged.
No AI grader was introduced.

## Validation

- Canonical answer: 100% through the real local scoring pipeline.
- 22 committed probe regression cases passed their expected classifications.
- Nine sandbox tests passed: absent host APIs and constructor escape, an empty
  SDK environment, filesystem imports, child processes, network access, imports
  outside allowed roots, symlink escapes, infinite loops, and heap exhaustion
  followed by a successful fresh probe.
- 25 full-pipeline cases (22 fixtures plus three archived Astra answers) reached
  their expected final outcomes. Valid fixtures include limits 1, 25, and 250;
  ascending, descending, and default ordering; aliases and late constants;
  imported/internal helpers; unrelated `collect` calls; and a native pagination
  page returned as an array.
- Negative fixtures cover unbounded reads, collect-then-slice, full iteration,
  disconnected bounded reads, caught unbounded-read errors, zero/infinite limits,
  empty results, global take-before-filter, wrong workspaces, duplicates, and
  changed document fields.
- All three archived Astra answers now pass the five data/API tests and fail
  only the bounded-read test (5/6 tests, 83.33%). No fresh model generations
  were needed for this grader correction.
- Repository typecheck and lint passed. The full test command passed 258 runner,
  script, and grader unit tests plus 50 evalScores tests.

Two initial fixture runs encountered the existing `bunx tsc` bootstrap failure
with dependency-resolution output but no TypeScript diagnostic. Their full
pipeline retries passed typechecking and produced the expected grader outcomes.
The internal-query fixture initially had a circular inferred return type; adding
an explicit TypeScript return annotation fixed that fixture, and its full
pipeline then passed without a grader change. The fixture builder now uses that
annotation consistently.

Unit probes used the root SDK (Convex 1.44.0); full-pipeline runs resolved the
reference answer's existing dependency range to Convex 1.45.0. All scoring used
disposable local backends with `DISABLE_CONVEX_REPORTING=1`. Historical scores and
benchmark metadata were not changed.

The final sandbox rerun classified all 25 cases as expected at the grader level.
Four cases also encountered the existing TypeScript bootstrap issue; these were
rerun separately through the full pipeline and reached their expected outcomes.

Local artifacts: `/tmp/astra-audit/bounded-sandbox-answer.log`,
`/tmp/astra-audit/bounded-sandbox-worker-regressions/results.json`, and
`/tmp/astra-audit/bounded-sandbox-retry-*/results.json` and
`/tmp/astra-audit/bounded-sandbox-final-*/results.json` files. The full-pipeline fixture
harness is `/tmp/astra-audit/bounded-regressions.ts`.
