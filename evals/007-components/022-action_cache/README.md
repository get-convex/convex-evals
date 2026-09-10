# Action Cache usage

## Why this matters

Expensive actions can execute again on each request. This eval measures correct
use of Convex's persistent Action Cache, especially passing freshness options
separately from generator arguments. Incorrect keys waste API calls or return
another product/language's result; incorrect TTLs serve stale results.

This is a docs-equipped usage eval, not spontaneous component selection.
One concept: persistent argument-keyed caching with TTL. The supplied generator
needs no network, credentials, application schema, or paid inference.

The grader checks reuse across separate actions, both key dimensions, decreasing
TTL on an existing entry, and expiry surviving a later longer TTL. It uses zero-TTL calls to exercise expiry and reads component metadata to
verify exact TTLs, without relying on wall-clock query invalidation. It does not require single-flight concurrency,
which Action Cache does not promise. Reference API: pinned package 0.3.1,
src/client/index.ts and src/component/lib.ts.

## Validation

Canonical answer: full local backend pipeline, 5/5 grader tests passed.
Negative controls also deployed and reached the grader:

- Ignoring maxAgeMs failed the expiry and stored-TTL checks.
- A one-minute default failed the exact default-TTL check.
- Bypassing the cache failed reuse and component-persistence checks.

No model generation or production reporting was used for these checks.

Astra pilot (one run per condition): default 5/5 and no_guidelines 5/5.
Both outputs deployed, typechecked, and linted successfully. Both preserved the
supplied generator and passed maxAgeMs as a fetch option, separately from the
generator arguments. Both added returns validators, accepted by the grader.
This is a small task/grader smoke test, not an estimate of guideline benefit.
