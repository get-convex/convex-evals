> **Readiness superseded by independent review.** The initial fixture results below are historical evidence for the first implementation, not sign-off on the current change. Fable and an independent replay found a valid native `URL` implementation rejected by the QuickJS probe. The correction and expanded audit are recorded in [the shared probe review](../../../docs/query-probe-review.md). Nothing has been pushed from this review batch.

# Platform URL env grader correction

Eval: `005-idioms/009-platform_env_urls`. Investigation and validation: 2026-09-09.
The changes are local for review, with no commit or push.

## Why this matters

The task explicitly requests Convex's generated typed `env` object to expose the
deployment's HTTP-action and client addresses, plus one optional application
variable. The platform supplies the two URLs. The application declares only
`PUBLIC_APP_NAME`. Confusing the addresses breaks callback/client routing;
ignoring actual configuration makes the returned application name unreliable.

The task remains useful and explicit. The correction changes grading evidence,
not the task, reference answer, guidelines, or five-test weighting. It does not
introduce an AI grader or measure spontaneous API selection.

## Reproduced problems

The original grader scored correct quoted return keys and an imported helper
4/5. Both passed deployment, TypeScript, lint, and the live behavior tests. The
remaining source check required particular return-expression shapes and compared
property source text, so `"siteUrl"` did not match `siteUrl`.

```ts
return {
  siteUrl: env.CONVEX_SITE_URL,
  cloudUrl: env.CONVEX_CLOUD_URL,
  appName: env.PUBLIC_APP_NAME ?? null,
};
```

Additional controlled probes exposed false positives. The old grader set the
application name only to `Whiteboard Live`, so this incorrect expression passed:

```ts
appName: env.PUBLIC_APP_NAME === undefined ? null : "Whiteboard Live";
```

It also accepted `[env.CONVEX_SITE_URL]` and `[env.CONVEX_CLOUD_URL]` as the URL
fields. `new URL` coerced these one-element arrays into strings while checking
the addresses. The query actually returned arrays instead of the requested URLs.

The identical two programs were replayed against the old and new graders:

| Program                       | Old score | New score |
| ----------------------------- | --------- | --------- |
| Hardcoded configured app name | 5/5       | 3/5       |
| URL fields returned as arrays | 5/5       | 2/5       |
| Correct quoted return keys    | 4/5       | 5/5       |
| Correct imported helper       | 4/5       | 5/5       |

These counterexamples are authored fixtures, not Astra outputs.

## Correction

1. Keep returns-neutral public function-spec comparison.
2. Verify both real deployment URLs and a null application name when unset.
3. Set two unique application names, then an empty string, then remove the
   variable. Check the full result, including both URLs, after each change.
   Fresh HTTP queries and bounded polling avoid subscription caches and sleeps.
   Cleanup removes the temporary configuration even after a failure.
4. Inspect SDK-generated types in either `server.d.ts` or `server.ts`. Require
   the two built-in string URLs and only the optional-string app declaration.
   Normalize property spelling and union order; retain duplicate members so
   redeclarations cannot be hidden by a map keyed by field name.
5. Execute the query with synthetic typed env values in the existing isolated
   query sandbox. Observe actual generated-env reads and reject executed raw
   environment reads, including aliases, helpers, module-level reads, and
   catch-and-fallback code. The returned configuration must match each input.

The probe covers production-shaped addresses and local addresses with distinct
ports, so replacing `.convex.cloud` with `.convex.site` cannot masquerade as
reading both platform values. Equivalent loopback spellings and trailing slashes
remain accepted; other URL components and the actual string field types matter.

Both SDK codegen formats, aliases, namespace imports, re-exports, computed keys,
destructuring, imported helpers, internal-query helpers, and optional return
validators are accepted. Fresh sandboxes permit module-level captures; actual
backend configuration changes independently verify freshness.

The raw-read restriction here covers every environment variable, including an
unrelated `NODE_ENV` read. This preserves the task's broader wording compared
with `006-typed_env`, whose restriction names two application variables. A local
object merely named `process` and an uninvoked raw reader do not establish an
actual environment read and are accepted.

The existing shared sandbox and Node subprocess wrapper are unchanged. Only
this eval's grader, checks, inspector, regression programs, and documentation
change. No Convex schema change is involved.

## Validation

- All 35 retained fixture programs have the expected full-pipeline outcomes:
  17 valid programs pass 100%; 18 incorrect programs fail the intended checks.
  Each retained result passes installation, deployment, TypeScript, and lint.
- The internal-query fixture needed an explicit handler return type to avoid
  circular generated-API inference. Two other typecheck attempts exited without
  compiler diagnostics; those same programs passed unchanged full reruns. The
  original results remain in the evidence, and the consolidated matrix identifies
  which run supplies each retained result.
- Three archived Astra `no_guidelines` answers were replayed unchanged. All still
  fail deployment because they invent an env API. Correcting false negatives in
  the grader does not change that classification.
- The reference answer scores 100% against a real local backend.
- All 475 repository tests pass, including 35 new execution regressions.
  Typecheck, targeted lint, formatting, and diff checks pass.
- All local runs used `DISABLE_CONVEX_REPORTING=1`. No fresh paid model generation,
  production reporting, historical score rewrite, or benchmark mint occurred.

## Limits and evidence

The execution probe checks representative configurations and executed paths,
not every possible program. It models env access and nested query helpers, not
every database syscall or Web API available in Convex. Unexpected probe errors
must be investigated against the real backend before being called model faults.
Generated-type inspection depends on the SDK's codegen metadata format. No AI
pass/fail judgment substitutes for these checks.

- Original quoted-key/helper evidence: `/tmp/astra-audit/platform-env-probes/results.json`.
- Old-grader false positives: `/tmp/astra-audit/platform-env-old-grader/results.json`.
- Identical-program comparison: `/tmp/astra-audit/platform-env-new-grader-comparison/results.json`.
- Consolidated fixture matrix: `/tmp/astra-audit/platform-env-final-regressions/verified-results.json`.
- Archived Astra replays: `/tmp/astra-audit/platform-env-astra-replay/results.json`.
- Reference validation: `/tmp/astra-audit/platform-env-answers-final.log`.
- Repository tests: `/tmp/astra-audit/platform-env-tests-final.log`.
- Typecheck and lint: `/tmp/astra-audit/platform-env-typecheck-final.log`, `/tmp/astra-audit/platform-env-lint.log`.
