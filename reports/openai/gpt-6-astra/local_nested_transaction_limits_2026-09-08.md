# Nested transaction limit grader correction

Eval: `005-idioms/008-nested_transaction_limits`.
Initial investigation: 2026-09-08. Execution-based correction: 2026-09-09.

## Why this matters

This task tests a native child-transaction budget that leaves the parent able to
save the job's rejection after the child's writes roll back. An application
`count` check does not establish that Convex enforces the child's write budget.
See [Convex's nested transaction limits documentation](https://docs.convex.dev/database/writing-data#limiting-nested-transactions).

The task now explicitly requests the native per-call limit and says that direct
child calls must still insert the requested count. It does not supply the option
names. This measures correct requested API use and rollback handling, not
spontaneous API selection.

## Problem and solution

The old AST checker searched for any `runMutation` expression whose options
resolved to a five-document limit. This caused two reproduced errors:

- It rejected valid object shorthand such as `const documentsWritten = 5` and
  `{ transactionLimits: { documentsWritten } }`.
- It accepted a correct-looking call inside an unused function, while the actual
  parent used a manual count gate and called the child without a native cap.
  That deliberately broken program scored 8/8.

The initial shorthand patch was held after the second counterexample. The final
change removes the AST search and executes the generated parent through its real
Convex SDK, inside the existing QuickJS sandbox. For counts 2, 4, 5, 6, and 10,
the inspector observes the first executed `writeDeliveries` call and requires:

- The original job ID and requested count.
- The SDK-consumed `transactionLimits.documentsWritten` value of exactly five.

The inspector suspends at that child call. It does not invent a child result,
synthesize a limit exception, or simulate rollback. The seven existing real
backend tests retain responsibility for schema, function signatures, direct
child execution, delivery contents, rollback, parent status, and job isolation.
There are still eight scoring tests in total.

Aliases, shorthand, quoted/computed keys, spreads, destructured methods, and
local/imported helpers execute naturally. The probe also supports ordinary job
reads and updates before the call, including filtered/indexed queries and
pagination. An unused example or a cap on an unrelated call cannot satisfy the
required operation. A parent that skips the child on overflow also fails.

## Validation

- All 30 sandbox regression cases pass: 17 valid alternatives are accepted and
  13 incorrect native-call implementations are rejected for the intended reason.
- The reference answer scores 100% through `scripts/validateAnswers.ts` on a
  disposable local backend.
- All 33 retained full-pipeline cases have their expected outcomes: the 17 valid
  alternatives score 100%, the 13 constructed mistakes fail the native-call
  check, and the three archived Astra answers retain their prior failures.
- The unused-call/manual-gate example now scores 7/8, failing only the native-call
  test. Manual overflow shortcuts and limited calls with a decoy zero count also
  score 7/8 and fail that test.
- Astra's manual child-side cap remains 6/8. Its two invented option shapes still
  fail TypeScript and score 5/8. These are replays of the saved outputs, not fresh
  generations under the clarified prompt.
- During fixture development, a `db.table` example failed public TypeScript
  checks even though its runtime path worked. It was replaced with public
  `db.get`/`db.replace` calls and revalidated through the full pipeline. It is
  excluded from the retained case counts.
- Repository typecheck and targeted TypeScript lint pass. All 396 repository
  tests pass: 342 runner/script/grader tests and 54 evalScores tests.

Local scoring used `DISABLE_CONVEX_REPORTING=1`. No paid model generation,
production reporting, historical score updates, or benchmark minting occurred.
The reference answer, schema, and guidelines are unchanged.

## Limits and evidence

This fixes the demonstrated source-matching defects and checks representative
runtime paths. It is not a proof about every branch or every SDK operation. An
unsupported pre-call operation is reported explicitly and needs investigation,
not automatic attribution to the model. The tiny read fixture is not a database
correctness oracle; that remains the real backend's role. No AI grader is needed
for the native-call property tested here.

The 30 reusable fixture programs and sandbox tests live in
`scripts/lib/nestedTransactionLimitsFixtures.ts` and
`scripts/nestedTransactionLimits.test.ts`.

Local evidence:

- `/tmp/astra-audit/nested-limit-execution-regressions/verified-results.json`
  consolidates the retained full-pipeline cases, with each result's evidence root.
- `/tmp/astra-audit/nested-limit-execution-regressions.ts` is the disposable replay
  harness; it also accepts `CASE_FILTER` for targeted reruns.
- `/tmp/astra-audit/nested-limit-execution-{answers,unit,tests,typecheck,lint}.log`
  contains the validation output.
- `/tmp/astra-audit/nested-limit-root-probe/results.json` preserves the original
  8/8 false positive, before this correction.

Validation completed locally before the changes were presented for review.
