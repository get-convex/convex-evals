# Client-executed web tools: local pilot

This pilot tests exact accounting of requests dispatched by our runner to Exa.
It is isolated from `no_guidelines_with_web`, scoring, Convex reporting, and CI.
It does not establish benchmark score comparability or production readiness.

## Run

Put `OPENROUTER_API_KEY` and `EXA_API_KEY` in the ignored root `.env`, then:

```sh
DISABLE_CONVEX_REPORTING=1 bun scripts/clientWebPilot.ts \
  openai/gpt-5.6-luna /absolute/path/prompt.txt /absolute/path/new-output-directory
```

The output directory must not already contain `events.jsonl`. The pilot never
loads a Convex client or invokes a scoring/reporting function. API keys are
redacted from the journal. No credentials belong in Git or prompts.

## Count semantics

- A requested call is a function call returned by the model.
- A search attempt sends one Exa `/search` request, with up to five results and
  at most 1500 characters of highlights per result. Search highlights are part
  of the search response, not separate `/contents` calls.
- A fetch attempt sends one Exa `/contents` request for exactly one URL. Exa
  receives a 30000-character cap; returned text is capped locally to 5000
  cl100k tokens before being passed to the model.
- Invalid arguments, unknown tools, duplicate IDs, and exhausted budgets are
  recorded rejections. They do not generate Exa requests.
- Every dispatch intent is appended and fsynced before attempting the HTTP
  request. Results include Exa request IDs, response status, response bodies,
  costs when provided, and the actual content returned to the model.
- No automatic tool or model retries occur. A model-requested retry with a new
  ID is a new counted invocation. Calls in a batch execute in response order.
- An HTTP response with unusable data is a failure. A network failure before a
  response has an unknown remote outcome. Killing the process can leave an
  unfinished intent. Neither is a successful tool execution. A crash between
  intent persistence and network dispatch cannot be classified as proof that
  the remote service received a request.
- Zero means a completed journal with zero requests, not absent telemetry.

Limits: six dispatched calls total, five per tool, seven model turns, at most
20 requested calls in a turn, 30 seconds per Exa request, 300 seconds per
sample, 2000 model output tokens per turn, and bounded response bodies.
Truncated model turns fail before executing partial calls. For this pilot,
tool IDs are unique across the sample; a provider that reuses IDs needs a
separate compatibility check before expansion.

## Validation on 15 September 2026

Two repetitions of each case on both `openai/gpt-5.6-luna` and
`anthropic/claude-fable-5.1` all passed (12 samples):

| Case                                      | Requested calls per sample | Searches | Fetches | Rejected |
| ----------------------------------------- | -------------------------: | -------: | ------: | -------: |
| Self-contained arithmetic                 |                          0 |        0 |       0 |        0 |
| Search, fetch, search in three tool turns |                          3 |        2 |       1 |        0 |
| Seven searches requested in one batch     |                          7 |        5 |       0 |        2 |

Including three initial successful smoke samples, journals contain **30 search
requests and six fetch requests**, all with successful results and 36 distinct
Exa request IDs. Exa's dashboard filtered to the dedicated pilot key independently
showed **30 searches + six Contents requests = 36**. Every paired-sample count
also matched a separate counter around the outgoing HTTP transport.

Reported API costs: $0.94007417 OpenRouter and $0.216 Exa. These exclude the
separate Claude CLI reviews. An initial Fable request was rejected with HTTP
404 before tool execution: its endpoints did not advertise `tool_choice`.
Omitting that optional parameter while retaining strict parameter routing
resolved it. Both models preserve full assistant messages and reasoning fields
across tool turns.

The pilot has 14 targeted tests, including real localhost HTTP 429/500,
malformed response, timeout, SIGKILL mid-request, journal replay, dispatch limits,
credential redaction, malformed tool arguments, special-token page text, and
truncated tool turns. Typecheck passed, as did the full repository suite:
586 Bun tests, one additional runner Vitest test, and 66 backend Vitest tests.

Fable assessed the design and reviewed the implementation through the actual
Claude CLI. Its initial code verdict was go for the bounded pilot. Three medium
error-handling findings were fixed and tested: response parsing classification,
untrusted result processing, and rejecting truncated tool-call turns. Its
follow-up review confirmed all three fixes and found no blocker for the bounded
local pilot. Fable reviewed supplied code; the test execution and Exa dashboard
reconciliation were performed separately by Codex.

Durable local evidence, prompts, raw journals, Exa dashboard snapshot, costs,
test output, and verbatim Fable reviews are in:

`/Users/m5-mike/Documents/Codex/client-web-pilot-2026-09-15/`

## Production transition remains separate

The client tool names, schemas, returned context, and loop behavior differ from
OpenRouter's server tools. Do not combine their scores into one historical
series. Before replacing production, integrate the mechanism into the normal
generation/scoring pipeline, propose any required schema/version change for
manual approval, validate representative real evals, and deploy through the
repository's release procedure.

The user intends to wipe the old web runs if the replacement works. Prepare an
exact run-ID manifest and restorable backup at cutover, including associated
evals, steps, and output files. Scope cleanup to the old web execution condition;
preserve default and no-guidelines baselines. The pilot does not delete runs or
disable existing scheduled workflows. The initial experiment inventory is a
read-only aggregate snapshot, not a complete deletion manifest.

Provider references:

- https://openrouter.ai/docs/guides/features/tool-calling
- https://exa.ai/docs/search/quickstart
- https://exa.ai/docs/contents/quickstart

## Runner integration under local review

The shared implementation now lives in `runner/models/clientWebTools.ts` and
`clientWebLoop.ts`. The standalone smoke CLI imports the same implementation
used by `Model.generate`. Enable the integrated path explicitly:

```sh
CLIENT_WEB_TOOLS=1 DISABLE_CONVEX_REPORTING=1 \
EVALS_EXPERIMENT=no_guidelines_with_web OPENROUTER_CONCURRENCY=1 \
MODELS=openai/gpt-5.6-luna \
TEST_FILTER='000-fundamentals/003-crons|007-components/004-choose_aggregate' \
OUTPUT_TEMPDIR=/absolute/path/new-validation-directory bun run local:run
```

Local opt-in runs require reporting disabled and the web condition selected.
Production reporting additionally requires GitHub Actions on `main` and
`ENABLE_CLIENT_WEB_PRODUCTION=true`. The path uses the existing system/task prompts, omits
Convex guidelines, retains medium reasoning and the model's existing output
limit per turn, and uses normal file parsing and grading. Seven turns and the
same six-request tool budget remain bounded; output tokens are limited per
turn, not cumulatively. Responses API models are explicitly rejected by this
local integration rather than silently switching their adapter.

Each attempt writes `research/.../attempt-N.jsonl`. The normalized usage records
all model turns plus Exa costs when every charge is present. Missing charge data
stays unknown. `usage.raw.clientWeb` stores the execution profile, exact local
attempt counts, outcomes, generation IDs, per-turn usage, and trace path. It
uses the existing raw-usage field, with no schema change. Transport, journal, and unresolved remote-outcome failures abort as infrastructure
failures without retrying the entire paid tool loop. Token-limit cutoffs retain
their text for normal grading, while exhausted tool turns or malformed batches
produce a scored empty answer. Partial tool calls are never executed. Complete
but empty provider responses remain infrastructure failures, as in the baseline.
`modelOutcome` identifies the distinction. Explicit `webResearch` counters feed
the existing leaderboard reducer, including observed zero, with no estimates.

The `CLIENT_WEB_TOOLS` flag alone cannot enable production reporting. See
[the rollout plan](client-web-rollout.md) for approval gates, the production key,
and reuse of the existing experiment after old-run cleanup.
