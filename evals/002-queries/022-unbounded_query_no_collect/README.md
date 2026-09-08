# 022-unbounded_query_no_collect

This eval is intentionally testing the model's default behavior for list-style Convex queries.

The task asks for `listAuditLogs`, but it does **not** explicitly ask for all audit logs. The grading philosophy is that an agent should not default to `.collect()` for a plain listing query like this. Instead, it should prefer a bounded read such as `.take(n)` or pagination.

## What this eval is trying to measure

We want to know whether the model has a safe default when the user asks for a list but does not explicitly say:

- return every row
- export all data
- fetch the complete set

In that situation, the safer default for an AI agent is:

- use `.take(n)` for a bounded preview or list
- or use pagination if the list should continue

Using `.collect()` by default is treated as a mistake in this eval.

## Why `.collect()` is considered wrong here

For a human, there are valid cases where `.collect()` is correct. But for agentic code generation, `.collect()` is often an unsafe default because:

- the task may describe a table that grows over time
- the user may only want a normal UI list, not a full export
- `.collect()` can silently create future performance problems

So this eval is intentionally biased toward agent safety. If the prompt does not explicitly require the full set, the model should avoid `.collect()`.

## What would make `.collect()` acceptable

If the task explicitly said something like:

- return all audit logs
- export every audit log for the workspace
- fetch the complete history

then `.collect()` would be a reasonable choice.

That is not what this task says.

## Grading contract

The task stays neutral about retrieval strategy. We are measuring whether the
model chooses a bounded database read by default. With guidelines, this also
measures adherence to the explicit bounded-read rule; without guidelines, it
measures whether the model independently makes that choice.

The task does not specify a limit or ordering. Any positive finite native bound
is accepted, including `take(1)`, `take(25)`, or `take(250)`, with either ordering
or the default order. Returning a native pagination result's `page` is also
accepted; the task still requires an array, not a pagination envelope.

Real-backend tests check empty workspaces and nonempty results for populated
workspaces. Each returned document must match a stored document in the requested
workspace, including its system fields, without duplicates. Other workspaces
surround the target in creation order to catch taking a global prefix before
filtering. There is no requirement to return exactly 100 rows or the newest rows.

The bounded-read check invokes only `index:listAuditLogs`, using the generated
project's real Convex SDK in a WebAssembly interpreter. It observes native query streams
and pagination requests when they are consumed:

- A query stream must carry a positive finite native limit, as `take(n)` supplies.
- A pagination request must supply a positive finite page size.
- The returned entries must come from those bounded reads.
- Unbounded reads fail even if followed by array slicing, or hidden in an imported
  or internal helper. Unrelated functions and objects with a `collect` method are
  not rejected just because their source contains that name.

The probe supplies synthetic rows and leaves database correctness to the deployed
tests. It checks native bounded API selection, not arbitrary JavaScript loop
termination or worst-case rows/bytes scanned by a filtered query. A timeout bounds
probe execution. Reading every page until exhaustion is deliberately not made to
finish in the probe.

Generated code has no host filesystem, process, environment, network, or module
loader. Static bundling only accepts the generated Convex source, its installed
dependencies, and the trusted inspector; resolved symlinks must stay in those
roots. The SDK's `process.env` export receives an empty object. Each interpreter
runs in a disposable worker with a 64 MiB guest heap limit, a two-second execution
deadline, and a ten-second worker timeout. The worker is terminated after every
result, including resource exhaustion.

Choosing a bounded preview does not prove that users can reach the whole
collection or that bulk work eventually completes. Those stronger pagination
and batching requirements are tracked separately in
[issue #286](https://github.com/get-convex/convex-evals/issues/286).
