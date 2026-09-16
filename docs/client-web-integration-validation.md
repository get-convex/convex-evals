# Client-owned Exa integration validation

Validated locally on 16 September 2026, before rollout preparation or old-run cleanup. No schema changes. See [the rollout plan](client-web-rollout.md) for subsequent operational work.

## What changed

The normal eval runner can now execute Exa search and page-fetch function calls itself under `CLIENT_WEB_TOOLS=1`. The validation runs used `DISABLE_CONVEX_REPORTING=1`. It uses the usual prompts, model output limits, file parser, and grader.

Every call has a durable journal, outcome, returned content, and provider request ID. Costs and tokens include all model turns and tool charges. Explicit search/fetch counters feed the existing leaderboard aggregation, including exact zero with the estimated flag false. Missing total cost remains unknown with known components retained separately.

## Matched real evals

24 scored samples: three models, two evals, two repetitions, with and without web tools. The evals were `000-fundamentals/003-crons` (full local backend pipeline) and `007-components/004-choose_aggregate` (component-selection grader). Tasks and graders were unchanged.

| Model            | No-web average grader score | Web average grader score | Fully passing samples, no-web / web |
| ---------------- | --------------------------: | -----------------------: | ----------------------------------: |
| GPT-5.6 Luna     |                       33.3% |                    33.3% |                           1/4 / 1/4 |
| Claude Fable 5.1 |                      100.0% |                   100.0% |                           4/4 / 4/4 |
| Grok 4.6         |                       75.0% |                   100.0% |                           3/4 / 4/4 |

These are wiring and regression samples, not evidence of a general score improvement. Two tasks and two repetitions do not establish statistical significance. Retained failures include wrong imports in generated cron code and Luna choosing an implementation that missed the aggregate-selection criteria. No grader or task was adjusted to improve these results.

## End-to-end tool evidence

Fable chose page-fetch calls naturally on the component task. Grok exercised searches, fetches, and the six-request budget in a real scored eval. Its first component run dispatched two searches and four fetches, rejected three extra calls, and still produced a passing answer.

Two additional forced-tool plumbing samples are excluded from the matched comparison. Each dispatched exactly one search and one fetch. Fable passed the full cron grader; Luna generated an incorrect import and failed deployment. Both retained complete telemetry.

Across the 14 web-enabled samples, the journals contain **9 searches and 17 fetches**, with **26 distinct Exa request IDs**. All dispatched requests returned successful API outcomes. There were 5 recorded budget rejections, zero unknown outcomes, and zero incomplete dispatches.

Exa's dashboard, filtered to `convex-evals-client-web-pilot`, independently
increased from 30 searches and 6 Contents requests to 39 searches and 23 Contents
requests. The difference is exactly **9 searches + 17 fetches = 26 requests**.
The balance decreased by $0.08, matching the Exa costs recorded in the journals.

Recorded API cost, including baselines and the forced plumbing samples: **$2.9453** ($2.8653 OpenRouter + $0.0800 Exa). Separate Claude CLI reviews are excluded.

## Tests and independent review

- Typecheck passed across runner, evalScores, and visualizer.
- Full suite: 592 Bun tests, one runner Vitest test, and 66 backend Vitest tests passed (659 total).
- Twenty focused tests cover accounting, real HTTP errors/timeouts, SIGKILL recovery, journal replay/redaction, request budgets, file parsing, cost completeness, and the existing leaderboard projection.
- Fable reviewed through the actual Claude CLI. Its first broad review hit its budget without a verdict. The narrower review identified cutoff classification; the integration now grades token cutoffs and exhausted tool turns instead of removing them as infrastructure failures.
- Fable reviewed the corrections and found no blocking issues, subject to checking journal redaction. That check passed, including a provider error containing a dummy credential.

## Remaining release boundary

The opt-in remains local-only. Production enablement, experiment-history separation, and old-run cleanup require the next reviewed change. Back up an exact old-web-run manifest before removal, and preserve both no-web baselines. No production data was changed.

The tools change the experimental conditions: explicit function schemas, returned page context, strict tool-capable routing, and up to seven model turns. Each turn retains the model output cap; the cap is not cumulative. Only Chat Completions is supported by this local integration. Transport failures and unresolved tool outcomes invalidate a run; model output/budget failures retain scored outcomes.

## Evidence

- Durable artifacts: `/Users/m5-mike/Documents/Codex/client-web-integration-2026-09-16/`
- Reproduction and semantics: `docs/client-web-pilot.md`
- Base checkout: `3e01f1562dee339a8504c27d97392c5ebfe361b5`
- Raw journals, generated files, per-eval grading logs, summaries, and verbatim Fable reviews are preserved.
