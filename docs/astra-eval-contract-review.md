# Astra eval task-contract review

2026-09-08 review of the 14 recurring `no_guidelines` failures and the adjacent
`006-typed_env` task. The tables below record the findings at review time.

2026-09-09 follow-up: the nested-limit correction is implemented and validated,
including the native-call task clarification and execution-based grading. See
[its validation report](../reports/openai/gpt-6-astra/local_nested_transaction_limits_2026-09-08.md).
The typed application env correction is also implemented and validated;
see [its validation report](../reports/openai/gpt-6-astra/local_typed_env_2026-09-09.md).
The other changes remain proposals. Historical results and benchmark versions
are unchanged.

## Conclusion

The recurring failures have several causes that must be assessed independently:
unclear task requirements, invalid generated implementations, graders that
recognize syntax rather than the relevant operation, incomplete runtime probes,
and scores whose meaning is narrower than application correctness.

The native-validator and heartbeat work already made their requested capability
explicit. The original nested-limit shorthand fix addressed a real false
negative but was insufficient: an unused native-limit example could fool the
same checker. The correction replaces that checker with observation
of the executed child call and retains the real-backend rollback tests.

The revised authoring guidance in [README.md](../README.md#writing-evals) replaces
the rule that guideline coverage alone establishes model fault. API knowledge
can legitimately be tested without supplying its documentation. That does not
remove the need to justify the graded requirement, distinguish alternative
valid implementations, or state what the resulting score establishes.

## Claims and decisions

Each row states one claim. "Keep" means the contract is defensible with the
stated evidence and limits, not that every possible grader path has been proven.
The component rows are a contract and interpretation review, not a new audit of
every branch in their static analyzers.

| Eval | Claim a pass should support | Contract/grader assessment | Decision |
| --- | --- | --- | --- |
| `001-data_modeling/014-heartbeat_isolation` | Implement explicitly requested isolation of frequent heartbeat writes from stable user profiles. | The revised task names the separate table, preserves profiles, and specifies repeated-heartbeat behavior. Backend tests inspect stored records, identity, and cutoff behavior. | Keep the current contract. Do not describe a pass as spontaneous selection of the isolation design. |
| `001-data_modeling/015-validator_composition` | Derive the four requested shapes through native object-validator composition while retaining original field validators. | The revised module task states derivation and reuse. The grader executes the pinned SDK and tracks returned validator identities and shapes. | Keep. This measures requested composition, not spontaneous cleanup or application authorization. |
| `002-queries/022-unbounded_query_no_collect` | Choose a finite database-read default for a plain workspace listing request. | The neutral prompt is intentional under the earlier decision. A selection miss is not proof of incorrect listing behavior. The execution probe still rejects valid bounded point re-fetches. | Preserve the agreed selection claim; fix the probe's supported operations. Complete pagination remains a separate requirement and issue. |
| `002-queries/024-time_window_argument` | Evaluate active items using caller-controlled time without reading the query's wall clock. | The task only asks for items that have not expired. It does not state caller-controlled time or reactive freshness. The improved execution probe tests a stronger requirement than the literal prompt establishes. | Clarify the task contract before treating every clock read as an unambiguous functional failure. Keep the useful execution/data checks once aligned. |
| `003-mutations/005-cascade_delete_nested` | Delete a user and all records dependent on that user or their posts, preserving unrelated data. | "Proper error handling" does not specify whether deleting an absent user should throw or succeed harmlessly. The current fixture also omits the user's comments/likes on other users' posts. | Specify missing-user behavior and add the missing dependency edges to behavioral tests. Keep parallelism and large-data handling out of this task's scored claim unless explicitly required and tested. |
| `005-idioms/006-typed_env` | Declare optional typed application variables and read their actual configured values with the specified defaults. | The task is explicit, but the only runtime case leaves variables absent. A fake local object named `env` passes every test. | Replace source-name evidence with actual configured-value round trips and generated-type checks; verify the values' origin. |
| `005-idioms/008-nested_transaction_limits` | Apply a native write budget to the child call while preserving the parent's ability to record rejection after rollback. | Direct-child and rollback tests are useful. The source checker accepts a correct call inside an uninvoked function, while the actual call has no native limit. | Observe the executed child call and its native options. Keep real-backend rollback tests. Do not ship the shorthand patch as the complete correction. |
| `005-idioms/009-platform_env_urls` | Use typed, platform-provided site/cloud URLs alongside declared optional application configuration. | The task explicitly requires typed `env`; Astra's invented API violates that contract. Quoted keys and imported helpers nevertheless cause false negatives in the source checker. | Keep the capability. Replace fragile return-expression inspection; retain deployment URL checks, live app-name changes, and generated types. |
| `007-components/005-choose_rate_limiter` | Select and wire the official rate-limiter component for concurrent per-user quota enforcement. | Static selection pipeline; custom implementations are rejected without a behavioral comparison. | Keep as a selection metric, not evidence that every custom limiter is broken. |
| `007-components/015-choose_agent_threads` | Select Agent-backed durable conversation history. | Static dependency, mounting, and call-path checks. | Keep as selection; usage/runtime coverage must establish durable conversation correctness separately. |
| `007-components/016-choose_agent_tools` | Select Agent threads and tool wiring for live-data conversations. | Static checks inspect the intended integration, not actual LLM/database behavior. | Keep as selection; do not infer grounded responses or successful tool execution from a pass. |
| `007-components/017-choose_agent_multi` | Select shared Agent threads for specialist handoff. | Static checks inspect named agents and shared thread wiring. | Keep as selection; a miss does not prove a custom handoff loses context. |
| `007-components/019-choose_presence_online` | Select Presence for reactive viewer state and expiry. | Product requirements are detailed, but the static grader requires the official component. | Keep as selection; actual expiry and isolation need usage tests. |
| `007-components/020-choose_presence_typing` | Select Presence for reactive typing indicators. | Same distinction between component choice and actual expiry behavior. | Keep as selection; do not report a custom implementation as behaviorally broken without exercising it. |
| `007-components/021-choose_presence_multisession` | Select Presence for aggregation across a user's live sessions. | Static wiring is checked; simultaneous sessions and cleanup are not executed by this pipeline. | Keep as selection; usage tests must establish aggregation and concurrency behavior. |

## Concrete counterexamples

These are controlled modifications to reference answers, not changes to saved
Astra outputs. Each reached the grader with passing installation, deployment,
TypeScript, and generated-code lint checks.

| Case | Actual behavior | Current score | Root problem |
| --- | --- | --- | --- |
| Native limit only in an uninvoked function | The parent rejects large counts manually and calls the child without native options. | 8/8 | The checker finds a call expression without proving it executes. |
| Local empty object named `env` in `006-typed_env` | Always returns defaults, regardless of deployment configuration. | 4/4 | Identifier matching plus defaults-only runtime coverage substitutes for reading configured values. |
| Typed platform URLs returned with quoted property keys | Same values and generated types as the reference. | 4/5 | Comparing raw property source text rejects equivalent syntax. |
| Typed platform URL reads inside an imported helper | Same values and generated types as the reference. | 4/5 | The analyzer requires particular same-module return expressions. |
| Bounded audit rows re-fetched by ID | Executes the required bounded query, re-fetches those rows, and returns the same documents. | 5/6 | The runtime probe does not support `db.get`. |
| Cascade delete returns normally when the user is absent | Correctly deletes existing users and dependencies; repeat deletion is harmless. | 3/4 | The task does not choose between idempotence and throwing. |
| Cascade delete omits the user's comments/likes on other users' posts | Those direct dependencies are not deleted by the implementation. | 4/4 | The test graph never includes those edges. |

The typed-env fake illustrates why the earlier 2/3 pass rate on the related task
cannot, by itself, prove Astra used the real typed API. Generated answers and
their behavior must be inspected before interpreting that apparent contrast.

## Proposed task clarifications

The nested-limit clarification has been applied. The other wording
changes below remain reviewable proposals, not edits to `TASK.txt`.

### Time-window query

Recommended addition, retaining freedom to name the time argument:

> The caller supplies a Unix timestamp in milliseconds. Return the active items
> as of that timestamp, including when it is in the past or future. Do not read
> the wall clock while evaluating this query.

This makes caller-controlled time part of the contract. It measures correct
implementation of that requested property, not spontaneous selection of a
reactive time-update strategy. If spontaneous strategy selection is the intended
goal instead, use a separate product scenario with observable freshness and
allowed alternatives rather than silently grading this narrower query as one.

### Cascade delete

To preserve the current grader's intended missing-user behavior, add:

> If the user does not exist, throw an error and leave all stored data unchanged.
> The error message is not prescribed.

Idempotent deletion is also a reasonable product choice, but would require a
different explicit contract. "Proper error handling" does not decide between
them. Add fixtures for comments and likes authored by the deleted user on another
user's surviving post, alongside other users' records that must remain.

The current reference loads dependent records with `collect()`. This eval should
make no claim about deletion of an unbounded account history; that needs the
separate batching/completion coverage already requested. Making a single
transaction delete arbitrarily many rows would be an incompatible requirement.

### Nested mutation limit

Clarify the existing phrase "limiting the nested call" as:

> Apply Convex's native per-call document-write limit to the nested mutation.
> The child itself must still insert the requested count when called directly.

Do not name `transactionLimits` or `documentsWritten` if recalling the API is
part of this task's claim. This clarification alone does not fix the grader;
the real invoked child must carry the budget.

### Bounded listing

The earlier approved decision deliberately retained a neutral task to measure
the default choice. Preserve that decision and describe the score accordingly.
Do not quietly turn it into an explicitly prompted usage task.

If the desired claim changes to functional bounded listing, a suitable separate
contract would say "return one finite batch from a workspace whose audit history
can keep growing." If it changes to complete browsing, specify a continuation
path and exercise every page. A fixed `take(n)` is not complete pagination.

## Grading requirements for the next corrections

| Target | Equivalent valid cases | Incorrect cases the grader must reject | Evidence to observe |
| --- | --- | --- | --- |
| Nested limit | Literal/shorthand/aliased options, quoted keys, local/imported helpers. | Missing/wrong native cap, cap on an unused or unrelated call, manual gate substituted for the cap, child-side cap, failed rollback, lost parent status. | The invoked child's identity, arguments, and native budget; real-backend child and parent state at/beyond the boundary. |
| Typed application env | Aliased/namespace imports, destructuring, helpers, equivalent validators and fallback expressions. | Fake local `env`, hardcoded defaults, raw `process.env` where forbidden, wrong union/optionality, stale values after updates. | Generated type metadata; unset/set/change/unset values through the public query; provenance of the executed reads. |
| Platform env | Quoted/shorthand return keys, imported helpers, equivalent imports. | Swapped or fabricated URLs, redeclared platform variables, fake/raw env reads, hardcoded app name. | Exact deployment addresses, generated platform types, and live app-name round trips; provenance independent of return syntax. |
| Bounded listing | Existing aliases/helpers plus bounded point re-fetches. | Unbounded reads, collecting all pages, slicing after an unbounded read, disconnected bounded calls, cross-workspace rows. | Consumed native read bounds and real returned documents. Do not reject harmless SDK operations simply because the mock omitted them. |
| Cascade delete | Different iteration/parallelization and error wording; the chosen missing-user contract. | Orphaned cross-post comments/likes, deletion of another user's unrelated data, changed data on a rejected request. | A dependency graph covering both direct authorship and ownership through posts; complete remaining documents. |

Execution should handle syntax and helper indirection naturally where feasible,
but a sandbox/mock is not automatically a complete solution. Keep real-backend
tests, add supported-operation regressions, and state that representative probes
do not establish correctness for every possible input or branch. Do not replace
these concrete checks with an AI pass/fail judgment.

## Supplied-context issues

- Standard `no_guidelines` generation omits guidance and research tools; code is
  scored without a repair loop. Interpret its API failures under those conditions,
  not as a verdict on a documentation-assisted coding workflow.
- The generic backend prompt requests Convex `^1.44.0`, while the seven reviewed
  selection tasks request exactly `1.41.0`. The task's specific requirement is
  reasonably controlling, but the contradictory instructions should be removed.
- The generic prompt always requests `tsconfig.json`, while heartbeat and cascade
  tasks give narrower exclusive file lists. Make task-specific file/version
  requirements authoritative in prompt generation. This is a separate input
  cleanup, not an established cause of Astra's invented env API.
- `006-typed_env` and `009-platform_env_urls` share setup but have distinguishable
  claims: application validators/defaults versus built-in platform addresses.
  Keep both only with those distinct assertions. Shared setup alone is not a
  reason to merge them, nor should it be mistaken for independent evidence of
  two unrelated capability failures.
- Selection results should remain distinguishable from behavioral correctness
  in reports and future score presentation. This review does not change their
  weighting or excuse failed component-selection checks.

## Order of work

1. Completed: replace nested-limit source matching with executed native-call
   inspection and retain real-backend rollback checks. See the validation report.
2. Typed application env grading is corrected. Next, review platform env grading;
   share only justified instrumentation and preserve their distinct claims.
3. Review the proposed time-window and missing-user contract clarifications,
   then add the cascade dependency-graph cases. Do not silently rewrite past
   task interpretations.
4. Repair bounded point-read support under the already agreed selection claim.
5. Resolve generic prompt/file/version conflicts and review how selection scores
   are presented, separately from changing individual task scores.

Keep these as separate reviewable changes. A changed task claim belongs to a new
benchmark version once the batch is ready and minting is explicitly approved.

## Evidence and limits

Current task text, grader source, reference answers, the actual prompt renderer,
and the original six saved Astra run records were inspected. Earlier unchanged
regression suites were reviewed from their reports; they were not all rerun.
No fresh model generation or production reporting was needed for this review.

- Existing validator review: [validator-composition-eval-proposals.md](validator-composition-eval-proposals.md).
- Existing heartbeat review: [local_heartbeat_isolation_2026-09-08.md](../reports/openai/gpt-6-astra/local_heartbeat_isolation_2026-09-08.md).
- Existing native-limit false positive: `/tmp/astra-audit/nested-limit-root-probe/results.json` (all stages and 8/8 tests pass).
- Existing platform-env counterexamples: `/tmp/astra-audit/platform-env-probes/results.json` (reference 5/5, helper and quoted keys 4/5, all three Astra answers fail deployment).
- New typed-env/cascade cases: `/tmp/astra-audit/contract-probes/results.json` (references 100%, fake env 4/4, idempotent delete 3/4).
- New bounded re-fetch cases: `/tmp/astra-audit/bounded-refetch-contract-probe/results.json` (reference 6/6, valid re-fetch 5/6).
- New incomplete cascade case: `/tmp/astra-audit/cascade-cross-edge-probe/results.json` (the implementation omitting direct authored dependencies still scores 4/4).

All scoring probes used disposable local backends and
`DISABLE_CONVEX_REPORTING=1`. AI grading remains disabled in
`grader/aiGrader.ts`. The scope is the reviewed tasks and demonstrated cases,
not a certificate that the entire benchmark has no defects.
