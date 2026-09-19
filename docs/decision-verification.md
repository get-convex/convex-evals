# Decision question verification

The [authoring standard](decision-question-authoring.md) requires executable evidence before accepting a question. This release preserves the evidence behind the frozen 106-question candidate and provides portable replay for five questions, including the three items Astra missed. Full-bank historical execution is **not** yet a portable replay suite.

The [manifest](../verification/decisions/manifest.json) maps every final question to its knowledge target, coverage limit, exact question and option hashes, author record, independent review, and recorded evidence. The candidate represents 90 of the original 112 coding evals. Retirements and coverage gaps remain in the archived coverage ledger.

## Check the complete evidence package

From a clean checkout with Node.js 24 or newer:

```sh
node verification/decisions/verify.mjs
```

This requires no npm install, network access, credentials, provider calls, or backend. It checks the compressed and uncompressed archive hashes, each published artifact hash, all final question-file and option hashes, and every accepted evidence link. It does not rerun historical observations or prove their conclusions.

The immutable archive is a gzip-compressed JSONL file containing 2,626 selected records, about 1.5 MB compressed and 14 MB uncompressed. It includes all 1,036 directly referenced accepted evidence files, selected exact fixture sources, expected and observed cases, repair controls, verification programs, author records, and independent reviews. It excludes `node_modules`, backend databases and storage, environment files, generated fixture types, and unrelated inference output. Historical batch records can also mention retired questions or earlier wording; only the manifest's question index defines the final accepted bank.

Inspect it without unpacking thousands of files:

```sh
# Show the final question's evidence and hashes.
node verification/decisions/inspect.mjs question 000-fundamentals/010-staged_index q1

# List matching artifact origins, then print one artifact.
node verification/decisions/inspect.mjs list staged_index
node verification/decisions/inspect.mjs artifact outputs/failure-pilot/evidence/000-fundamentals/010-staged_index/execution-evidence.json

# Inspect all original source eval dispositions and coverage gaps.
node verification/decisions/inspect.mjs artifact outputs/bank-revision/coverage-ledger.json
```

Each record carries `originalSha256` for the historical bytes and `sha256` for the published bytes. Local workspace/user paths are normalized and historical local backend credentials are redacted. `sanitization` names these transformations. Internal historical hashes remain historical hashes; a changed sanitized copy is never presented as byte-identical. `@historical-home` and `@historical-repository` are explanatory markers, not dependencies on a particular machine. Original source and option hashes remain available for provenance.

## Supported portable replay

Each adapter verifies the frozen question file, extracts the actual recorded fixture source, checks its binding to the displayed code, and executes in a disposable temporary directory. They use committed npm lockfiles with Convex 1.41.0 or 1.44.0, TypeScript 5.7.3, and Node types 22.10.5. The Agent fixture additionally pins Agent 0.6.4, AI SDK 6.0.229, provider-utils 4.0.39, and convex-helpers 0.1.120 alongside its recorded dependency set. `npm ci` installs dependencies from the public npm registry with package scripts disabled. Reports record installed package versions and lockfile hashes. Node and npm come from the caller's runtime/PATH; `--npm` can supply a specific executable. No existing project `node_modules`, account configuration, or API keys are used.

| Question | Executed checks | Evidence limit |
| --- | --- | --- |
| `000-fundamentals/010-staged_index/q1` | Four exact options and three recorded minimal repairs at both SDK pins. Each variant typechecks independently and executes its native SDK descriptor. | Declaration/signature semantics only. No schema deployment, backfill duration, large-table behavior, or later activation is measured. |
| `000-fundamentals/000-empty_functions/q1` | The exact displayed program plus its recorded internal-dispatch control on a real local backend. Three public calls succeed; three internal calls are denied to the ordinary client; the bridge succeeds. | Visibility and dispatch only. Does not establish authentication or authorization. Repairs are not applicable to this outcome-prediction question. |
| `001-data_modeling/016-schema_document_validator/q1` | Four exact options and three recorded repairs. The five loadable variants each run the 19 recorded argument cases with freshly generated IDs/timestamps. The two missing-method options fail static checking and module initialization. | Tests complete-document argument validation using the unchanged original schema. Does not test restore logic, record existence, authorization, or alternate table schemas. No argument cases are claimed for variants that cannot initialize. |
| `005-idioms/008-nested_transaction_limits/q1` | Four exact options and three repairs; isolated static checks; 42 cases across counts 0, 1, 2, 5, 6 and 10; seven native-error diagnostics; an uncapped direct-child control. Persisted rows, parent status, recipients, and an unrelated job are checked. | Native document-write caps and caught-child rollback only. Static errors are bypassed deliberately for runtime observation; this does not make the rejected option shapes valid. |
| `007-components/017-choose_agent_multi/q1` | Exact recorded Agent program with a deterministic local model. All four predictions are compared with the stored four-message transcript. A separate original-reference control verifies the three-message path that suppresses the operational prompt. | Agent 0.6.4 default persistence/attribution only. No paid provider calls, model-quality claim, or knowledge-provenance claim. Repairs are not applicable to this outcome-prediction question. |

Run the SDK adapter:

```sh
node verification/decisions/replay.mjs staged-index --output staged-index-replay.json
```

Static rejection and SDK execution remain separate observations. The three incorrect options are executed with typechecking bypassed deliberately, so the report can distinguish rejected signatures, an absent method, and an ordinary index descriptor. Runtime success alone does not make a choice correct.

For the real-backend adapter, supply a Convex local backend binary that supports `keygen admin-key`. The original run used release `precompiled-2026-09-16-8600144`, with SHA-256 `cf8e4761382ab4b758198af6209074cf3d0b5abd84697c27c7e0ab44baff58e7` for its macOS binary. Obtain the appropriate platform binary from the [Convex backend releases](https://github.com/get-convex/convex-backend/releases/tag/precompiled-2026-09-16-8600144). The adapter does not download or execute an unrequested binary automatically.

```sh
node verification/decisions/replay.mjs visibility \
  --backend /path/to/convex-local-backend \
  --output visibility-replay.json

# The three missed items use the same disposable backend interface.
node verification/decisions/replay.mjs document-validator \
  --backend /path/to/convex-local-backend --output document-validator-replay.json
node verification/decisions/replay.mjs nested-limits \
  --backend /path/to/convex-local-backend --output nested-limits-replay.json
node verification/decisions/replay.mjs agent-attribution \
  --backend /path/to/convex-local-backend --output agent-attribution-replay.json
```

Each backend adapter records the supplied binary's hash and whether it matches the historical binary. A different platform/build can rerun the cases, but is a new runtime identity. It generates a fresh instance secret and admin key, binds both ports to loopback, disables analytics/reporting, deploys only into that disposable local backend, and removes the backend state and temporary dependencies afterward. Visibility has no schema; the other fixtures copy the unchanged original schema and assert its recorded hash. Repository source files and application schemas remain unchanged. The report excludes credentials and normalizes temporary paths.

## Remaining portability work

The other 101 accepted questions have inspectable recorded evidence, but no supported clean-checkout behavioral replay command in this package. Historical source is preserved for review, not offered as a complete executable dependency graph. Do not run an archived script by assuming its relative paths resolve in this repository.

The remaining adapters need to:

1. Replace the historical shared harness's workspace layout, preinstalled sibling module directories, fixed runtime/backend paths, and local credentials with the disposable runner used here.
2. Add lockfiles or reuse the new Agent lockfile for the remaining component-specific dependency sets, including Workpool, Presence, Aggregate, Rate Limiter, Action Cache, and HTTP fixtures. Preserve the recorded SDK/component combinations rather than using the root package versions.
3. Translate each batch's fixture generation, expected cases, and saved-result assertions into an explicit replay entrypoint. Bind any reused pilot fixtures and later wording to the final question/option hashes, preserving applicability reviews.
4. Recreate generated API types in isolated fixtures, typecheck variants independently, and run the exact option and repair cases. Check backend identity and preserve unchanged source schemas.
5. Revalidate the complete supported set from a clean checkout before claiming full-bank reproducibility.

The evidence also has limits beyond portability. Validator-as-argument substitutes do not become direct table-write tests. Native SDK descriptors do not measure index backfill. Concurrent requests and retry logs do not establish an untraced ordering of internal reads. Tiny successful runs do not prove performance properties. Read each author record's applicability and coverage limits alongside the observations.
