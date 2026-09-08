# No guidelines with web

`no_guidelines_with_web` is the sole web experiment. It asks whether a
model can produce better Convex code by seeking public information when it has
neither the Convex guidelines nor the Convex plugin.

Status: implemented, including the approved schema and reporting support.
Release the updated backend before enabling scheduled runs or reporting this
experiment. Use `DISABLE_CONVEX_REPORTING=1` against a backend that has not been
updated. The old experiments remain retired.

## Agreed direction

- Use our own harness with a common `web_search(query)` and `web_fetch(url)`
  interface for every model.
- Use the same search backend, result format, page extraction, and resource rules
  across models. Search returns sources and excerpts, without another model
  synthesizing the answer.
- Search the ordinary public web. Finding authoritative information is part of
  the task; the tool is not restricted to Convex documentation.
- Keep the ordinary task prompt unchanged, omit Convex guidelines, and make
  research optional. Do not require search or tell models to look up Convex docs.
- Compare against `no_guidelines` using matched tasks, grading, model settings,
  and repeated runs. Grade the resulting code; tool use alone earns no points.
- Record queries, returned search results, pages actually read, and the returned
  page content alongside generated code, usage, and cost.
- Use those traces to investigate documentation discovery and application
  failures. A failed task or an unused tool does not by itself prove the docs
  are unclear.

## Implementation and limits

The harness enables OpenRouter's [web search](https://openrouter.ai/docs/guides/features/server-tools/web-search)
and [web fetch](https://openrouter.ai/docs/guides/features/server-tools/web-fetch)
server tools. Both specify `engine: "exa"`, so the search and extraction backend
is the same across models. The search mode is explicitly Exa's `auto` mode;
this does not enable OpenRouter's automatic engine selection or native search.
There is no domain allowlist. Only the existing `OPENROUTER_API_KEY` is needed.

Every request sends the same fixed tool limits:

- `max_tool_calls: 6` for OpenRouter's server-tool loop budget.
- At most five searches and five fetches, using each tool's `max_uses`.
- Five results per search, 25 results overall, and at most 1,500 characters of
  source excerpts per result.
- At most 5,000 approximate tokens of extracted page text per fetch.
- A five-minute generation timeout and a 16 MB response stream limit enforced
  by our harness.

Search remains optional: `tool_choice` is `auto`, and the task prompt is identical
to `no_guidelines`. Custom guideline files are rejected. Models retain their
existing Chat Completions or Responses API adapter and output-token setting.
OpenRouter executes the intermediate tool loop. We do not control its individual
model steps, reserve a final answer step, or independently enforce a cumulative
output-token allowance across those hidden steps. Keep this distinction in mind
when interpreting a comparison with the baseline. SDK model retries remain at
five; the server tool limits apply per request, including a retried request.

API errors, invalid or interrupted streams, and timeouts fail as infrastructure
errors. Page-specific failures handled inside OpenRouter's loop can be returned
to the model; Chat Completions does not expose enough detail to classify every
internal search or fetch failure independently.

## Running locally

The existing root `.env` provides `OPENROUTER_API_KEY`. Choose a supported model
slug and a small eval filter:

```bash
DISABLE_CONVEX_REPORTING=1 \
EVALS_EXPERIMENT=no_guidelines_with_web \
MODELS='your-model-slug' \
TEST_FILTER='000-fundamentals/003-crons' \
bun run local:run
```

The interactive `bun run evals` menu also includes the experiment. Disable
reporting until the target backend supports the new schema literal. After
deployment, local runs may report only to development. A missing OpenRouter key
fails before model discovery or generation.

## CI rollout

After the normal release workflow deploys the additive schema change, set the
repository variable `ENABLE_NO_GUIDELINES_WITH_WEB=true`. The existing periodic
workflow then runs the selected models under default, `no_guidelines`, and
`no_guidelines_with_web` conditions. Each model/condition has its own job and
120-minute timeout; the matrix retains the four-job concurrency limit. Clearing
the variable stops future scheduled web runs without affecting the baselines.

The manual workflow also has a `run_no_guidelines_with_web` input, disabled by
default. It can run this condition alone by disabling its two baseline inputs.
Reporting remains restricted to GitHub Actions on `main`.

Both workflows upload the web condition's `research/` directory as an Actions
artifact, including after failures, with 30-day retention. Download it before
expiry for longer-term analysis. Run usage contains the research summary and
local trace path; the full trace is in the artifact, not in the Convex database.

## Traces and evidence limits

Each generation attempt writes an atomic JSON trace under
`<OUTPUT_TEMPDIR>/research/<model>/<category>/<eval>/attempt-N.json`, including
failed attempts. The runner prints the path. Generated projects use the sibling
`output/` directory as usual. Use a fresh output directory for each repetition.

Trace version 2 records the exact request bodies, both pinned engines, raw JSON
stream events, citations and source excerpts, completed server-tool items when
exposed, optional router metadata, partial/final text, and returned usage.
Authorization headers are never saved. Each HTTP retry has its own request entry.

The trace is explicitly marked `provider-visible-only`:

- Chat Completions exposes citations/excerpts and usage counters. Our live check
  did not expose the search query or complete fetched-page contents.
- Responses exposes `openrouter:web_search` and `openrouter:web_fetch` items when
  provided. Our live check included the search query, source URLs, and fetched
  page content.
  The harness saves these before excluding the custom items from the installed
  OpenAI SDK's parsing view. This does not alter what the evaluated model sees.
- Missing counters remain null. Observed tool-item counts are separate from
  provider-reported request counts; neither is inferred from prose or citations.
- Cost is exactly what OpenRouter reports. If absent, it stays unknown: a model
  token-price estimate would omit search/fetch charges. Failed requests without
  usage cannot be included in a measured total.

These API paths have different trace visibility. Do not call citations a complete
research history, or interpret missing search metadata as zero searches. The raw
stream is retained so additional provider details can be extracted later.

Before claiming a score improvement, choose a representative task subset and
run matched repetitions of both conditions. A forced-search smoke test verifies
tool wiring only and must not be included in the benchmark results.

## Cleanup boundary

The earlier provider-search and native coding-harness experiments have been
retired. Their implementations, launch workflow, and results handoff were removed;
do not restore them or treat their old results as measurements of this design.
They remain recoverable from Git history if needed.

The old `web_search` and `web_search_no_guidelines` literals still exist in the
Convex schema and backend types solely for compatibility with stored historical
records. They are not runnable experiments. No deployed records were deleted or
renamed. Historically, `web_search` used guidelines plus OpenRouter-managed
search, and `web_search_no_guidelines` omitted the guidelines. Neither label
represents the new common-tool experiment. Removing them requires a separately
approved schema and data-change plan under AGENTS.md. The additive
`no_guidelines_with_web` literal was approved on 2026-09-08 and needs no backfill.
