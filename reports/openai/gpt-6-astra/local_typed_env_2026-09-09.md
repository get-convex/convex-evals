# Typed application env grader correction

Eval: `005-idioms/006-typed_env`. Local investigation and validation: 2026-09-09.

## Why this matters

The task explicitly requests Convex's typed environment variable API: declare an
optional support email and an optional three-value deployment-stage union, then
expose their configured values through a public query. The declaration provides
type and configuration validation; correct default values alone do not establish
that the application reads its deployment configuration.
See [Convex's typed environment variable documentation](https://docs.convex.dev/production/environment-variables#declaring-environment-variables).

## Reproduced defect

The original grader ran the query only with both variables unset. Its other
three tests inspected source text, including exact validator strings and return
expressions referencing an identifier named `env`.

A controlled reference modification replaced the real import with:

```ts
const env: {
  SUPPORT_EMAIL?: string;
  DEPLOYMENT_STAGE?: "dev" | "preview" | "prod";
} = {};
```

The handler still returned defaults through this object and never read a
configured deployment value. It scored 4/4 before the correction. This is a
fixture we authored to test the grader, not an archived Astra answer.

## Change

The grader still has four scored tests, with evidence replacing syntax matching:

1. Check the public no-argument query contract and its unset defaults. Function
   comparison ignores return validators and does not prescribe internal helpers.
2. Check the types that Convex generated from the deployed declarations:
   `SUPPORT_EMAIL` is `string | undefined`, and `DEPLOYMENT_STAGE` has exactly the
   three requested literals plus `undefined`. Validator aliases, helpers, literal
   order, formatting, and quoted properties do not determine the result.
3. Set, change, and remove real deployment values and query over fresh HTTP
   requests. Exercise both variables independently, every stage, changed email
   values, reset defaults, and an empty email string. An empty string is a set
   optional string, so `isConfigured` must remain true. Use unique email values,
   bounded polling, and cleanup rather than fixed sleeps or cached subscriptions.
4. Execute the query in the existing sandbox with synthetic values and observe
   typed versus raw app-variable reads. Returned values must match each input.
   Aliases, namespace imports, destructuring, local and imported helpers, and
   module-level reads are accepted. Executed raw reads through aliases, computed
   properties, helpers, or caught errors cannot satisfy the typed-API constraint.

The SDK implements its generated `env` export using `process.env`. The new
optional sandbox mode replaces only that generated export's initializer with a
tracked guest object. Authored code uses a separate tracked guest `process.env`.
Both contain only synthetic test values. Candidate code is not executed in the
host Node context, and neither path exposes host environment variables.

The substitution works with both SDK codegen formats: JavaScript plus declaration
files, and TypeScript using the `globalThis` initializer. Other sandbox users
retain their previous default behavior.

The raw-read restriction is scoped to these two app variables on executed query
paths. An unrelated raw variable, an uninvoked reader, or a local object merely
named `process` is not rejected by name. The task and reference are unchanged;
there are no schema or guideline changes and no AI grader.

## Validation

- The deliberately fake local `env` drops from 4/4 to 2/4. Defaults and native
  declarations still pass; configured-value behavior and typed-read provenance
  fail.
- All 34 retained fixture programs have the expected full-pipeline outcome:
  16 valid alternatives score 100%, and 18 incorrect implementations fail the
  relevant scored tests. All 34 pass installation, deployment, TypeScript, and
  generated-code lint, so these are grader outcomes rather than incidental
  setup failures.
- The invalid set includes fake/default-only outputs, raw app-variable reads,
  wrong empty-string handling, ignored stage-only configuration, and missing or
  incorrect native declarations. A type assertion without native declarations
  passes runtime reads but fails the generated-declaration check.
- Full-backend validation exposed two fixture assumptions: spreading `env` and
  using `in` did not expose configured variables as plain-object operations
  would. They are retained as incorrect cases, and the sandbox now matches the
  backend's property-read behavior. Explicit copies and checks against
  `undefined` are valid alternatives and pass. Raw-access fixtures include the
  necessary TypeScript declarations so missing Node typings do not mask the
  intended API-use failure.
- Three saved Astra `no_guidelines` answers were replayed unchanged. The two
  previous passes remain 100%, including their optional return validators. The
  answer that invented an env API still fails deployment. No fresh model
  generation or guideline-effect claim is involved.
- All four reference answers using the shared sandbox score 100% through real
  local backends: typed env, nested write limits, bounded listing, and the time
  window query.
- All 430 repository tests pass (376 runner/script/grader tests and 54 evalScores
  tests), including the 34 new sandbox cases. Typecheck, targeted lint, and diff
  checks pass.

All local runs used `DISABLE_CONVEX_REPORTING=1`. Historical scores and benchmark
versions were not changed. The user reviewed the correction and approved
committing, pushing, and merging it on 2026-09-09.

## Evidence and limits

The probe checks representative configurations and executed paths; it is not a
proof about every possible program. It supports query helpers but does not
simulate unrelated database or other SDK operations. Unsupported operations must
be investigated rather than automatically attributed to the model. Live backend
round trips independently establish actual configured values and update behavior.
Generated-type checks depend on the SDK codegen metadata, not candidate-authored
annotations.

- Baseline false positive: `/tmp/astra-audit/typed-env-baseline/results.json`.
- Verified fixture matrix: `/tmp/astra-audit/typed-env-final-regressions/verified-results.json`.
- Archived Astra replays: `/tmp/astra-audit/typed-env-astra-replay/results.json`.
- Shared reference validation: `/tmp/astra-audit/typed-env-shared-sandbox-answers.log`.
- Repository verification: `/tmp/astra-audit/typed-env-{tests,unit,typecheck,lint}.log`.
- Replay harness: `/tmp/astra-audit/typed-env-regressions.ts`.
