# Time-window query grading

## Why this matters

Time passing does not rerun a subscribed Convex query. Reading `Date.now()` in
`listActive` can leave expired items visible and reduce cache reuse. This task
intentionally leaves the argument name and signature unspecified: the model must
choose a caller-supplied timestamp. The original design is recorded in
[issue #214](https://github.com/get-convex/convex-evals/issues/214).

The task, reference answer, schema, and six existing API/data tests are unchanged.
Those tests discover the timestamp argument by type, then check multiple cutoffs,
the strict expiration boundary, ordering, the 100-item cap, and empty results.

## Correcting the source check

The former whole-file AST check rejected a correct query when its builder was
stored in a variable before `.take(100)`. It also rejected `Date.now()` in an
unrelated mutation. Neither changes the query's behavior.

The replacement runs `listActive` through the generated project's Convex SDK in
the shared WebAssembly sandbox. It observes the native read that is consumed,
including reads through aliases, imported helpers, and internal queries. The
read must use the expiration index, the supplied strict lower bound, ascending
order, and a native limit of at most 100. Synthetic document IDs connect the
returned rows to that read. Real-backend tests still establish data correctness.

A clock trap is installed before loading the query module. `Date.now()`, bare
`Date()`, and zero-argument `new Date()` fail when executed, including captured
module-level reads, helper calls, and errors caught by the query. Deterministic
conversions such as `new Date(args.now)` are allowed. Uninvoked mutations and
helpers are not executed. The probe samples empty, partial, and full results at
three cutoffs; it does not prove that every possible branch is free of clock reads.

Database filters and unbounded reads remain rejected. Array method names are no
longer blanket-banned: harmless transformations of an already correct bounded
result do not establish a database scan. Incorrect results still fail the
deployed tests. A disconnected indexed query cannot justify an unbounded read.

## Sandbox reuse

The sandbox and its worker were moved from eval 022 into `grader/`. Both evals
use the same import restrictions, empty environment, absent host APIs, memory
limit, and worker timeout. The existing bounded-query fixtures and sandbox
security tests cover the extraction. No new dependency or AI grader is added.
