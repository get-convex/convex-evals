- See package.json to work out how to run the models
- Model definitions are stored in /runner/models/index.ts
- Models run periodically via github actions
- When adding a new model, please run it at least once against one or two evals to make sure it works
- This project uses bun extensively, including for its package manager and running tests and scripts
- You should look at the package.json for the scripts you can use
- You should `bun run typecheck` regularly to ensure that any changes have not broken the types
- Run `bun run test` to run all test suites (runner unit tests + evalScores backend tests). Do this after making changes to the runner or evalScores backend.

## API Keys & Environment

All API keys (OpenAI, Anthropic, Google, etc.) are stored in the root `.env` file and loaded automatically via `dotenv`. You do not need to set them manually — they are already configured for local development.

## Running Evals Locally

Use environment variables `MODELS` and `TEST_FILTER` with `bun run local:run`:

```bash
# Run a single eval for a specific model:
MODELS=gpt-5.2-codex TEST_FILTER=000-fundamentals/003 bun run local:run

# Run all fundamentals for a model:
MODELS=gpt-5.2-codex TEST_FILTER=000-fundamentals bun run local:run

# Run multiple specific evals (TEST_FILTER is a regex):
MODELS=gpt-5.2-codex TEST_FILTER="003-crons|012-index_and_filter|000-use_query" bun run local:run

# Run with a different experiment:
EVALS_EXPERIMENT=no_guidelines MODELS=gpt-5 TEST_FILTER=000-fundamentals/000 bun run local:run
```

The `local:run` script is just `bun run runner/index.ts`. The convenience aliases `local:run:fundamentals` and `local:run:one` in package.json show the pattern.

The interactive `bun run evals` script provides a menu-driven way to select models and evals.

## Convex Deployments

[text](https://www.convex.dev/llm-leaderboard/with-guidelines)
The evalScores backend has two Convex deployments:

- **Production**: `https://fabulous-panther-525.convex.cloud` — used by CI/GitHub Actions. The GitHub secret `CONVEX_EVAL_URL` must point to this URL.
- **Development**: `https://brazen-pelican-414.convex.cloud` — used for local development (`bun run dev` in evalScores/).

Codex worktree setup runs `.codex/environments/setup.mjs`, which installs dependencies and creates ignored `.env.local` files pointing `evalScores` and the visualizer at the development deployment. For existing worktrees or manual repair, run `bun run setup:convex`. `bun run dev` also runs this setup automatically.

The Convex LLM leaderboard (https://www.convex.dev/llm-leaderboard/) uses the dat from the production version of this convex deployment.

The runner communicates with the Convex backend via `ConvexClient` using the public mutations/queries in `evalScores/convex/admin.ts`. Authentication is done via a bearer token passed as an argument to each function (validated against the `authTokens` table). The GitHub secret `CONVEX_AUTH_TOKEN` holds this token for CI.

When deploying changes to the evalScores backend, use `npx convex deploy` from the `evalScores/` directory (handled automatically by the release workflow). Do NOT deploy local dev changes to production accidentally.

## Deployment & Migration Workflow

When making schema or data changes to the Convex backend that require migrations:

1. **Never deploy directly to production** from your local dev environment.
2. **Commit and push to `main`** to trigger the `release.yml` workflow, which auto-deploys the Convex backend to production.
3. **Monitor the deploy** via: `gh run list --workflow=release.yml --limit=1 --watch`
4. **After the deploy completes**, run any pending migrations via the CLI:
   ```bash
   cd evalScores && npx convex run migrations:runAll --prod
   ```
5. **Monitor migration progress**:
   ```bash
   npx convex run --component migrations lib:getStatus --watch --prod
   ```
6. **If the migration enables further schema tightening** (e.g. making optional fields required, removing deprecated tables), make those changes in a **second commit** and push again to deploy the tightened schema.

There are currently no historical backfills left in `migrations:runAll`, but we keep the scaffold in place for future schema/data migrations.

The general pattern is: deploy code first (with loose/compatible schema), run data migrations if needed, then deploy tightened schema.

## Deleting a Run

To delete a run from the production Convex deployment (e.g. if it was corrupted by rate-limit errors), use the `deleteRun` internal mutation. This cascade-deletes all evals, steps, and output storage files associated with the run, and decrements the experiment stats.

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
- `bunx convex codegen` fails without a deployment; to produce `answer/convex/_generated`, copy it from a sibling single-module eval (they are module-name-generic) or run `bun run generate:answer-types`. The scorer regenerates during deployment anyway.
- Validate any touched eval against a real local backend before pushing: `TEST_FILTER='<eval-name-regex>' bun run scripts/validateAnswers.ts` must report 100%.
- Each answer's `package.json` pins its own deps (the root lockfile does not constrain generated projects); pin exact versions for component evals.
