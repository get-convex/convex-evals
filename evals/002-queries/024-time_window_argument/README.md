# Caller-controlled time

## Why this matters

Convex subscriptions react to data changes, not merely to time passing. A query
that compares expiration timestamps with its own clock can leave stale results
visible. The task now explicitly asks for a caller-supplied timestamp, including
historical and future cutoffs, so that the query result follows an observable
input. The model chooses the argument name. This measures implementation of the
requested behavior; it does not measure spontaneous strategy selection.

See [Convex's time-dependent query guidance](https://docs.convex.dev/understanding/best-practices#dont-use-datenow-in-queries)
and the original design discussion in [issue #214](https://github.com/get-convex/convex-evals/issues/214).

## Grading

The six API/data tests check the supplied timestamp argument, strict expiration
boundary, multiple cutoffs, ascending ordering, the first 100 results, and empty
results. They run the original candidate on a real Convex backend.

The seventh check observes clock reads while invoking the query over 105 real
rows at cutoffs that produce full, partial, and empty results. It also runs in
Convex's native runtime through the shared one-off query runner. It installs
clock traps before importing candidate modules, including captured and imported
helpers. Same-project nested query helpers remain in the trapped context.
Database operations run on the actual backend, without a simulated query builder
or synthetic document IDs.

The probe observes clock reads; it does not mandate an index, a native limit
operator, or a particular filtering method. The live tests remain responsible
for the returned count, cutoff and ordering. A bounded iterator, pagination,
and a correctly capped alternative can satisfy this task. Access-pattern
selection belongs to the dedicated evals that declare that measurement.

The checks distinguish reading the current time from deterministic conversion
of an explicitly supplied date or timestamp. A caught prohibited clock read still
fails. An unsupported probe operation is an infrastructure failure, not a model
score. No AI grader is used.

## Evidence limits

Finite examples do not prove that every possible branch is free of clock reads.
A pass establishes the observed caller-time behavior and runtime checks, not
complete pagination, a frontend timer, automatic subscription refresh, or
production-scale read efficiency.

See [the independent review record](../../../docs/query-probe-review.md) for
counterexamples, decisions, and validation evidence.
