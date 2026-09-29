- See package.json to work out how to run the models
- Model definitions are stored in /runner/models/index.ts
- Curated models run periodically via GitHub Actions, but only while the Periodic Evaluations workflow is enabled (`gh workflow list --all`)
- When adding a new model, follow `.cursor/skills/add-model/SKILL.md`, which includes running it against one or two evals to make sure it works
- This project uses bun extensively, including for its package manager and running tests and scripts
- You should look at the package.json for the scripts you can use
- You should `bun run typecheck` regularly to ensure that any changes have not broken the types
- Before opening a PR, run what PR Checks (`.github/workflows/pr_checks.yml`) runs:
  ```bash
  bun run typecheck
  bun run test
  bun run lint
  bun run format-check:guidelines
  bun run decisions validate && node verification/decisions/verify.mjs
  bunx vitest run grader/pollUntil.test.ts
  cd visualizer && bun run test && bun run build
  ```

## Paid Runs and Repo Settings

- Before any paid model run, local or workflow, state the estimated dollar cost and get Mike's approval. Estimate it from per-run averages with the cost-lookup snippet in `.cursor/skills/add-model/SKILL.md` (step 6).
- Local runs must set `MODELS` (or `-m` for `bun run evals run`). Without it the runner runs every model in `ALL_MODELS` (`DEFAULT_MODEL_NAMES` in `runner/index.ts`), about $87 per full pass as of 2026-09-29.
- Validate Guideline Changes (`validate_guidelines.yml`) is manual dispatch only. It runs two full suites (before and after) for each of its four default models, about $45 unfiltered as of 2026-09-29, so it needs an estimate and approval like any paid run.
- When starting a batch of workflow runs, dispatch one first and check it before dispatching the rest. For untested models, dispatch `manual_evals.yml` with `-f max_concurrency=2` or lower.
- Never enable or disable workflows, or change repo variables, secrets or branch settings, without asking Mike. An agent disabled Periodic Evaluations on 2026-09-16 and it stayed off for 13 days.

## Pull Requests and Merging

Never push directly to `main`. Every change goes through a PR and merges only after PR Checks pass. Until branch protection exists, nothing technically stops a direct push, and a direct push deploys to production through `release.yml`.

- Agents may merge their own PRs that only change docs, skills, tests or dev tooling (setup scripts, repo config for agents), and only after CI passes.
- Changes to runner behavior, workflow triggers or state, spend, the Convex schema, or production data need Mike's go-ahead before merging. So do new evals and eval changes.

## Skills

Task playbooks live in `.cursor/skills/<name>/SKILL.md`. Read the matching one before starting.

- `add-model`: use when the user wants to add or onboard a model, or names a new model or OpenRouter link for the leaderboard.
- `add-eval`: use when the user wants to add a new eval, test a new Convex concept, or expand eval coverage.
- `analyze-eval`: use when the user shares a visualizer URL for a specific eval, asks about a specific failing eval, or references an eval ID.
- `analyze-run`: use when the user asks to analyze an entire run, review all its failures, or understand why a model scored poorly.
- `validate-guidelines`: use when proposing or reviewing changes to `runner/models/guidelines.md`, or when the user asks to validate guidelines.

## Web experiment direction

`no_guidelines_with_web` is the sole web experiment, using client-owned Exa
search and page-fetch tools. Set `CLIENT_WEB_TOOLS=1`; eval runs cannot use the
historical unfiltered server-tool path. Both `OPENROUTER_API_KEY` and `EXA_API_KEY`
are required. See `docs/web-source-filtering.md` for benchmark-source protections
and limits, and `docs/client-web-rollout.md` for a record of the rollout. Use
`DISABLE_CONVEX_REPORTING=1` for local validation.
It runs in production. The repo variables `ENABLE_CLIENT_WEB_PRODUCTION`
(required for web runs from main-branch Actions) and
`ENABLE_NO_GUIDELINES_WITH_WEB` (adds the web condition to the periodic
schedule) have both been `true` since 2026-09-16. Periodic web runs skip the
models in `PERIODIC_WEB_EXCLUDED_MODELS` (`runner/models/index.ts`).
The earlier provider-search and native coding-harness experiments are retired;
do not resume them from old handoffs. Historical experiment literals in the
backend are storage compatibility only.

## API Keys & Environment

New worktrees have no `.env` and no `evalScores` or `visualizer` dependencies, so run `bun run setup` first. It installs root, `evalScores` and `visualizer` dependencies, copies `.env` from another worktree when it is missing, and runs `bun run setup:convex`.

Keys live in the root `.env`, loaded via `dotenv`. Coding runs send every model through OpenRouter, so they need only `OPENROUTER_API_KEY`, plus `EXA_API_KEY` for web runs. `bun run decisions run` defaults to `--provider typesafe`, which needs `TYPESAFE_API_KEY`, so pass `--provider openrouter` to use OpenRouter.

## Running Evals Locally

Use environment variables `MODELS` and `TEST_FILTER` with `bun run local:run`. `MODELS` takes OpenRouter slugs. A bare name like `gpt-5` fails discovery and the runner exits. Always set `MODELS` and state the cost first (see Paid Runs and Repo Settings).

```bash
# Run a single eval for a specific model:
MODELS=openai/gpt-5.2-codex TEST_FILTER=000-fundamentals/003 bun run local:run

# Run all fundamentals for a model:
MODELS=openai/gpt-5.2-codex TEST_FILTER=000-fundamentals bun run local:run

# Run multiple specific evals (TEST_FILTER is a regex):
MODELS=openai/gpt-5.2-codex TEST_FILTER="003-crons|012-index_and_filter|000-use_query" bun run local:run

# Run with a different experiment:
EVALS_EXPERIMENT=no_guidelines MODELS=openai/gpt-5 TEST_FILTER=000-fundamentals/000 bun run local:run
```

The `local:run` script is just `bun run runner/index.ts`. The convenience aliases `local:run:fundamentals` and `local:run:one` in package.json show the pattern.

The interactive `bun run evals` script provides a menu-driven way to select models and evals.

## Convex Deployments

The evalScores backend has two Convex deployments:

- **Production**: `https://fabulous-panther-525.convex.cloud` — used by CI/GitHub Actions. The GitHub secret `CONVEX_EVAL_URL` must point to this URL.
- **Development**: `https://brazen-pelican-414.convex.cloud` — used for local development (`bun run dev` in evalScores/).

Codex worktree setup runs `.codex/environments/setup.mjs`, which installs dependencies and creates ignored `.env.local` files pointing `evalScores` and the visualizer at the development deployment. For existing worktrees or manual repair, run `bun run setup:convex`. `bun run dev` also runs this setup automatically.

The Convex LLM leaderboard (https://www.convex.dev/llm-leaderboard/) uses the dat from the production version of this convex deployment.

The runner communicates with the Convex backend via `ConvexClient` using the public mutations/queries in `evalScores/convex/admin.ts`. Authentication is done via a bearer token passed as an argument to each function (validated against the `authTokens` table). The GitHub secret `CONVEX_AUTH_TOKEN` holds this token for CI.

Backend changes reach production through `release.yml`, which runs `bunx convex deploy` on every push to `main`. Never run `npx convex deploy` against production yourself.

## Production Access

Agents usually cannot run `npx convex run --prod`, because the Convex team requires SSO ("Single-sign on login is required to access this team").

Public queries work over HTTP without auth:

```bash
curl -s https://fabulous-panther-525.convex.cloud/api/query -H 'Content-Type: application/json' -d '{"path":"module:function","args":{}}'
```

- Public: `models:getBySlug`, `modelScores:getSchedulingStats`, `runs:listExperiments`, `runs:listRuns`, and `runs:getRunDetails` (a run's evals with statuses and steps).
- Internal, so HTTP returns a bare `Server Error`: `debug:getEvalDebugInfo` (used by analyze-eval and analyze-run), `debugQueries:getFailedEvalsForRun` (used by analyze-run), `runs:deleteRun`, and everything in `migrations` and `benchmarkVersions`. Give Mike the exact command to run from `evalScores/`.

Any write to the production deployment needs Mike's explicit go-ahead first. That covers migrations, `deleteRun`, and seed or backfill functions. Give Mike the exact command rather than running it yourself.

## Deployment & Migration Workflow

Every push to `main` runs `release.yml`, which deploys the backend to production. Changes must reach `main` through a merged PR (see Pull Requests and Merging).

### Schema Change Approval Gate

Before making any Convex schema change, show the user the proposed schema diff
and explain its migration and deployment implications. Wait for the user's
explicit approval before editing `evalScores/convex/schema.ts`, adding a schema
migration, or deploying the schema change to any Convex deployment.

When making schema or data changes to the Convex backend that require migrations:

1. **Open a PR against `main`.** PR Checks must pass, and the merge needs Mike's go-ahead.
2. **Merging deploys.** The merge triggers `release.yml`, which deploys the Convex backend to production.
3. **Monitor the deploy.** Find the release run for the merge commit, then watch it:
   ```bash
   gh run list --workflow=release.yml --commit <sha>
   gh run watch <run-id> --exit-status
   ```
   A `cancelled` release run usually means a newer push superseded it in the `production-release` concurrency group, so check the latest release run.
4. **After the deploy completes**, get Mike's go-ahead and give him the command to run pending migrations. `runAll` runs the migrations listed in `evalScores/convex/migrations.ts` and skips completed ones.
   ```bash
   cd evalScores && npx convex run migrations:runAll --prod
   ```
5. **Monitor migration progress** (also a command for Mike):
   ```bash
   cd evalScores && npx convex run --component migrations lib:getStatus --watch --prod
   ```
6. **If the migration enables further schema tightening** (e.g. making optional fields required, removing deprecated tables), make those changes in a **second PR** after the migration completes.

The general pattern is: deploy code first (with loose/compatible schema), run data migrations if needed, then deploy tightened schema.

## Benchmark Version Minting

Benchmark versions are minted manually, never automatically as part of a
release. When a batch of eval additions or meaningful eval changes appears to
be complete, tell the user that it is probably a good time to mint a new
benchmark version. If the user expects more eval work over the next few days,
offer to schedule a follow-up task to revisit minting after that work is done.

Do not mint or publish a benchmark version without the user's explicit
approval. Minting is metadata-only and must not trigger paid model runs; the
normal periodic schedule populates the new version over time.

Minting runs only through the workflow on `main`, and only with Mike's approval:

```bash
gh workflow run mint_benchmark.yml --ref main -f kind=coding   # or kind=decision
```

`bun run benchmark:mint` fails without `BENCHMARK_KIND` and refuses production
outside that workflow.

Local eval runs must never write to the production Convex deployment. Local
runs may report only to the development deployment. Production eval reporting
is reserved for GitHub Actions running on `main`.

## Deleting a Run

To delete a run from the production Convex deployment (e.g. if it was corrupted by rate-limit errors), use the `deleteRun` internal mutation. This cascade-deletes all evals, steps, and output storage files associated with the run, and decrements the experiment stats. It is a production write, so get Mike's explicit go-ahead first and give him the command to run:

```bash
cd evalScores && npx convex run runs:deleteRun --prod '{"runId": "<convex_document_id>"}'
```

The `runId` is the Convex document `_id` for the run, which appears in the runner output as `Completed run <id>`. You can also find run IDs via the Convex dashboard or the visualiser.

**Note:** Eval source files are intentionally preserved since they are deduped/shared across runs.

## Run Analysis Reports

The `reports/` directory contains post-run analysis reports organised by provider and model:

```
reports/{provider}/{model}/{run-id-prefix}_{date}.md
```

For example: `reports/anthropic/claude-opus-4-6/jn72t14a_2026-02-06.md`

Each report contains:

- Per-failure classification (model fault, overly strict testing, ambiguous task, known gap)
- Cross-cutting patterns across failures
- Actions taken (lint config changes, grader fixes, task updates)
- Net impact assessment

When investigating a model's performance or deciding whether to adjust eval requirements, check the reports directory for prior analyses of the same model or similar failure patterns.

## Authoring New Evals

Conventions established during the 2026-07 eval-roadmap work (waves tracked in GitHub issues):

- When a guideline recommends a component, describe its capability SHAPE (e.g. aggregates: counts/sums/ranks/offsets over many rows), never the eval's application domain - a guideline mentioning "leaderboard" is overfit to the eval that motivated it. Generalize or enumerate use-cases; then rerun the ablation to prove the generalized wording still lands.
- In guidelines, prefer concrete instances over placeholder syntax: `components.myName.index.myFunction` landed where `components.<name>.<module>.<function>` did not (verified by model runs).
- When investigating what models actually do (component choice, pattern use), run BOTH conditions: default and `EVALS_EXPERIMENT=no_guidelines`. The delta is the guideline's measured contribution; identical behavior in both conditions means the guideline line is not earning its tokens.
- Coverage standard per covered component: at least 3 selection scenarios (distinct capability shapes/domains) and at least 1 usage eval (API docs in task, full pipeline).
- SELECTION evals use the static pipeline: ship an `eval.json` with `{ "pipeline": "static" }` and a grader that only parses the generated files (import from `grader/outputDir`, not `grader/index` - no backend env exists). This grades what the model CHOSE, deliberately tolerant of syntax errors and stale versions; the paired usage eval grades correctness with full pipeline + docs in its task.
- Component-specific API reference (constructor options, method signatures) never goes in the global guidelines - it goes in the eval's TASK.txt as a minimal reference excerpt, simulating an agent that fetched the component's docs. Guidelines carry only generic platform knowledge (mounting, local-component authoring, subtransaction semantics).
- Guidelines are paid for twice: they steer graded models here AND get pulled into every user's project context. Add a guideline line ONLY when it demonstrably helps models pass a specific eval (use `ablation:generate`/`ablation:run` to prove it), keep it as terse as possible, and prefer improving an existing line over adding a new one. Never add guidelines speculatively.
- Component evals come in two kinds: USAGE evals name the component and test correct wiring (pin exact versions); SELECTION evals state only the product requirement and test that the model chooses the component over hand-rolling (no version pins possible - grade version-agnostically via behavior and scan bans).
- Every eval issue and PR must include a "Why this matters" section: what Convex-specific knowledge is being measured and what silently breaks in production when a model lacks it. If you cannot articulate the why, the eval is probably testing trivia.
- One concept per eval. If a task needs auth AND concurrency AND error shapes, split it - see the README's eval-writing rules.
- Do NOT put `returns:` validators in reference answers unless the task explicitly tests them (only `000-fundamentals/009-returns_validator` and `002-queries/018-pagination_returns_validator`). Answers are likely training data and the guidelines deliberately mandate only argument validators.
- Graders must be returns-neutral: use `compareFunctionSpec(skip, { ignoreReturns: true })`, plus `publicOnly: true` when the task does not dictate internal function names/modules.
- Never use fixed sleeps for scheduled work in graders - use `pollUntil` from `grader/pollUntil.ts`, and give slow poll-based tests explicit vitest timeouts (the scorer's vitest budget must exceed the summed per-test timeouts of the slowest grader; see `runner/scorer.ts` TIMEOUTS).
- AST/source checks must be precise: tie checks to the consumed call chain (not "identifier appears somewhere"), resolve named constants anywhere in the file, and scope wall-clock/scan bans to what the task actually forbids. Behavioral tests should defeat cheats where possible (multi-cutoff, crowd-out, inverted-input patterns) before reaching for AST checks.
- To produce `answer/convex/_generated`, copy it from a sibling single-module eval (they are module-name-generic). `bunx convex codegen` fails without a deployment, and the scorer regenerates during deployment anyway.
- Validate any touched eval against a real local backend before pushing: `TEST_FILTER='<eval-name-regex>' bun run scripts/validateAnswers.ts` must report 100%.
- Each answer's `package.json` pins its own deps (the root lockfile does not constrain generated projects); pin exact versions for component evals.
