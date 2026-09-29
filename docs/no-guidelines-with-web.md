# No guidelines with web

`no_guidelines_with_web` is the sole web experiment. It asks whether a
model can produce better Convex code by seeking public information when it has
neither the Convex guidelines nor the Convex plugin.

See [benchmark source filtering](web-source-filtering.md) for the enforced policy
and its limitations. Web eval runs require `CLIENT_WEB_TOOLS=1`. Setting it for
any other experiment throws.

## Current rollout

The replacement implementation uses client-owned function calls to Exa so the
harness records every dispatched search and page fetch itself. It reuses
`no_guidelines_with_web` after deleting the old runs; no schema change is needed.
Use `CLIENT_WEB_TOOLS=1` and `DISABLE_CONVEX_REPORTING=1` for local pilots, with
both `OPENROUTER_API_KEY` and a development `EXA_API_KEY` configured.

See [the rollout state](client-web-rollout.md). Periodic Evaluations runs the web
condition, except for models in `PERIODIC_WEB_EXCLUDED_MODELS`
(`runner/models/index.ts`). Published runs cannot fall back to the old
server-tool path.

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

## Tool limits and traces

The model gets `web_search(query)` and `web_fetch(url)` function tools. The
harness runs them against Exa (`runner/models/clientWebTools.ts` and
`clientWebLoop.ts`) with these limits per sample:

- Six dispatched calls in total, at most five per tool. Rejected calls never
  reach Exa.
- Seven model turns, at most 20 requested calls per turn.
- 30 seconds per Exa request and five minutes for the whole loop.
- Search returns up to five results, each with at most 1,500 characters of
  excerpts. Fetch returns one page, capped at 5,000 cl100k tokens.
- The model's usual output limit applies to each turn, not cumulatively.

Research stays optional: requests omit `tool_choice`. Only Chat Completions
models are supported. Each generation attempt writes a JSONL journal to
`<OUTPUT_TEMPDIR>/research/<model>/<category>/<eval>/attempt-N.jsonl`. Run usage
stores the counts, costs and trace path under `usage.raw.clientWeb`.

## Running locally

Use the commands in [Local reruns](web-source-filtering.md#local-reruns). The
`bun run evals` launcher sets `CLIENT_WEB_TOOLS=1` and `DISABLE_CONVEX_REPORTING=1`
itself; a direct `bun run local:run` must set both. Both `OPENROUTER_API_KEY` and
`EXA_API_KEY` must be set, for example in the root `.env`. Local web runs cannot
report to any deployment, including development.

## CI

The repository variable `ENABLE_NO_GUIDELINES_WITH_WEB` has been `true` since
2026-09-16. While it is set, the periodic workflow runs the selected models under
default, `no_guidelines`, and `no_guidelines_with_web` conditions. It skips only
the web condition for models in `PERIODIC_WEB_EXCLUDED_MODELS`. Each
model/condition has its own job and 120-minute timeout; the matrix retains the
four-job concurrency limit. Clearing the variable stops future scheduled web runs
without affecting the baselines.

The manual workflow also has a `run_no_guidelines_with_web` input, disabled by
default. It can run this condition alone by disabling its two baseline inputs.
Reporting remains restricted to GitHub Actions on `main`.

Both workflows upload the web condition's `research/` directory as an Actions
artifact, including after failures, with 30-day retention. Download it before
expiry for longer-term analysis. Run usage contains the research summary and
local trace path; the full trace is in the artifact, not in the Convex database.

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
