# JSONC type cleanup and benchmark boundary

The scorer removes unresolved `compilerOptions.types` entries from generated
projects before typechecking. It now parses tsconfig files with TypeScript's
JSONC parser, so comments and trailing commas no longer bypass this cleanup.
Malformed configurations stay untouched, and resolvable type entries stay in
place. This change does not alter the separate module-resolution normalizer
or the existing type-package resolution policy.

Two saved GLM 5.3 answers reproduced the format-dependent failure locally:

- `jn70wdtmpn2z7v3hzgv0kc1rgs8ef9k1`, `000-fundamentals/000-empty_functions`:
  missing `node` types; all seven behavioral tests passed.
- `jn742wddnx21nc5qxx383nr5xn8eev2a`, `001-data_modeling/006-literals`:
  missing `vite/client` types; both behavioral tests passed.

The original commented configurations pass the full local scoring pipeline
with the corrected parser. Application source and dependency declarations
were unchanged; no fresh model generation was needed.

## Release requirement

Scoring protocol 3 gives this correction a new benchmark identity because
shared scorer code is not automatically hashed. At this change's 112-eval
suite, the identity changes from
`5e62440997bc8eb797a9742093e857373cb9815433a089b2c11a4fa8f8768d80` to
`41d65c9b4f5bcdb97bc5c6ead5aa054e335b2eab6abc897b352b97b98b016fb3`.

Coordinate release with an explicitly approved benchmark mint before expecting
new results to populate the public leaderboard. The code change itself does
not mint a benchmark, rewrite historical scores, or authorize paid runs.
