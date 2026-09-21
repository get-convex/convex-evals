# Filtering benchmark sources from web evals

The September trace audit found models seeking the benchmark's reference answers
and graders. Returned sources included the eval repository and the public
`stack.convex.dev/convex-evals` article, which reproduces tasks and expected code.
Ordinary documentation search must not expose those known benchmark sources.

The client-owned tools enforce `exclude-known-benchmark-sources-v1`:

- Reject fetch URLs and explicit search queries identifying `convex-evals`
  (including case changes, percent encoding, raw/CDN URLs, forks, and named
  mirrors) before dispatch.
- Inspect every returned URL, title, excerpt and page body before creating the
  model's tool message. Discard known benchmark sources, including the public
  eval article, regardless of the query used to find them.
- Reject recognizable copies of the six-empty-functions benchmark example,
  even when the mirror omits its original repository URL/title.
- Filter the entire returned content before clipping. Do not expose provider
  error payloads as tool messages. Ordinary Convex docs and component source
  repositories remain available.
- Preserve raw provider responses and `source_blocked` events in the research
  journal. The model receives only filtered results. An all-blocked response
  returns an empty result list; the dispatched request still counts and costs
  money. Rejected pre-dispatch calls do not consume provider request budget.
- Record the source-policy version in the journal header and raw usage metadata.
  Eval runner entrypoints require `CLIENT_WEB_TOOLS=1`, even for local runs;
  the historical server-tool adapter is only retained for low-level diagnostics.

These are protections against **known** sources, not a guarantee that every
possible answer copy or prior training exposure is excluded. Exa performs remote
page extraction: we inspect the URL/content it returns, not its internal redirect
chain. An anonymous mirror without recognizable source/content markers can evade
this policy. Never describe this as a complete website allowlist or proof that a
model cannot encounter any reference answer.

## Local reruns

Use the existing development credentials, with reporting disabled:

```sh
CLIENT_WEB_TOOLS=1 DISABLE_CONVEX_REPORTING=1 \
EVALS_EXPERIMENT=no_guidelines_with_web OPENROUTER_CONCURRENCY=1 \
MODELS=x-ai/grok-4.6 TEST_FILTER='000-fundamentals/003-crons$' \
OUTPUT_TEMPDIR=/absolute/path/to/fresh-rerun bun run local:run
```

Review the JSONL `tool_result.result` objects (what the model receives), separately
from `rawResponse` (audit-only provider data). A blocked source remaining in the
raw journal is expected and does not mean it reached the model.

Do not mix these local reruns with historical published scores. The old traces
used provider-owned server tools; the replacement client loop has different
execution semantics. Local reruns check current behavior, not the causal effect
of filtering alone. Publishing replacement results and changing the schedule are
separate rollout actions; this change does not mint a benchmark or alter schema.
