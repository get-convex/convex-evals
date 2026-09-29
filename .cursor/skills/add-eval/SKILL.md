---
name: add-eval
description: Design, implement, validate, and calibrate a new eval for the convex-evals suite. Use when the user wants to add a new eval, create an eval, test a new Convex concept, or expand eval coverage.
---

# Add a New Eval

Follow these steps whenever the user asks to create a new eval. Read `.cursor/skills/add-eval/reference.md` for grader helpers, test patterns, and conventions. The eval-writing rules in AGENTS.md ("Authoring New Evals") and README.md ("Writing evals") take precedence over this skill.

**Steps 0-2 (gather info, research, design) are collaborative and read-only.** Don't create or edit any files until the user has seen the research findings and approved the eval design. Implementation starts at Step 3.

## Step 0: Gather Information

Determine the following (ask the user if not provided):

1. **Concept to test** - what Convex feature or pattern should this eval exercise? (e.g. "vector search", "pagination with joins", "cascade deletes")
2. **Specific focus** - any edge cases, constraints, or behaviors the user wants to emphasize?

### Category Selection

List the existing categories by scanning `evals/` top-level directories, then propose the best-fit category. The current categories are:

| Category | Scope |
|----------|-------|
| `000-fundamentals` | Basic Convex concepts (empty functions, schema definition, crons, scheduling) |
| `001-data_modeling` | Schema design, indexes, relationships, unions, optional fields |
| `002-queries` | Reading data, joins, pagination, aggregation, filtering |
| `003-mutations` | Writing data, inserts, patches, deletes, cascades |
| `004-actions` | HTTP fetch, file storage, node runtime, HTTP action routing |
| `005-idioms` | File organization, internal functions, batch patterns |
| `006-clients` | useQuery, useMutation, usePaginatedQuery |
| `007-components` | Components: usage evals wiring a named component, selection evals choosing one, local components, function handles |

- If the concept **clearly fits** one category, propose it with a brief justification.
- If it's **ambiguous** (e.g. "scheduled mutations" could be fundamentals or mutations), stop and ask the user. Present the candidate categories with reasoning for each.
- If it **doesn't fit** any existing category, propose creating a new category and ask the user to confirm.

Determine the eval number by listing existing evals in the chosen category and picking the next sequential number.

## Step 1: Research

Run these four research tracks. Use sub-agents or parallel tool calls where possible.

### A. Convex Docs (source of truth)

1. Fetch `https://docs.convex.dev/llms.txt` to get the docs table of contents.
2. Identify the 1-3 most relevant doc pages for the concept being tested.
3. Use WebFetch to retrieve those specific pages.
4. Extract the correct API patterns, constraints, and best practices. These are ground truth for designing the eval and answer.

### B. Existing Guidelines

1. Read the relevant sections of `runner/models/guidelines.md` for the concept being tested. It is the source. `runner/models/guidelines.ts` only loads it.
2. Record:
   - Which existing guidelines are relevant
   - What behavior those guidelines would lead a model to produce
   - Whether the current guidelines would already be expected to make strong models pass
   - Whether any guideline seems to conflict with what the proposed eval is trying to reward
3. Do **not** treat this as a reason to block the eval automatically. This is context for design and later calibration.
4. If an existing guideline appears to directly contradict the proposed eval, **STOP and discuss with the user** before proceeding.

### C. Existing Eval Patterns

1. Read 2-3 evals in the same or a similar category.
2. Study: TASK.txt style, answer structure, test approach, schema design.
3. Note which grader helpers and test patterns they use. See `reference.md` for the full catalog.

### D. Overlap Check

1. List ALL eval directory names under `evals/` to get a high-level view of coverage.
2. For any eval whose name suggests overlap with the proposed concept, read its TASK.txt.
3. If an existing eval tests the **same or very similar** concept, **STOP and warn the user**:
   - Name the overlapping eval(s) and explain what they already cover.
   - Ask whether to: differentiate the new eval (narrow its scope), adjust the existing eval, or abandon.
4. Flag even **partial overlap**, e.g. "002-queries/012-index_and_filter already tests index usage but doesn't cover compound indexes."

## Step 2: Design the Eval

Present the full eval design to the user for review. Stay read-only until they approve it.

### Why this matters

State what Convex-specific knowledge the eval measures and what silently breaks in production when a model lacks it. Every eval issue and PR needs this section (AGENTS.md). If you can't write it, the eval probably tests trivia.

### TASK.txt Draft

Write the complete TASK.txt content. Follow these principles:

- **Laser-focused** on the concept being tested. Control other variables (keep schema simple, minimize unrelated code).
- **Explicit** about schema, function names, argument types, return shapes, and which files to create.
- **Don't over-specify** Convex implementation details that are covered by the guidelines. If a model needs the task to spell out how to use `internalMutation` or how pagination works, that's a meaningful signal, not a task problem.
- **Don't under-specify** the problem domain. The model should not need to guess what the feature does, only how to implement it in Convex.
- **Include schema** as a TypeScript code block when applicable.
- **Specify edge cases** (empty results, error messages, missing data).

### Answer Outline

Describe the files that will be created and the key implementation approach. Don't write the full code yet, just the structure and important decisions.

### Test Approach

Describe how the eval will be graded:

- Pick the primary grading primitive first: behavior tests, schema inspection, function-spec comparison, HTTP testing, AI grading, AST analysis, or some combination.
- Pick the pipeline: backend (default), static for selection evals, or module. See "Eval Pipelines" in `reference.md`.
- Which grader helpers to use (see `reference.md` for the catalog and decision tree).
- What behaviors to assert on.
- Whether standard unit tests are sufficient, or if you need schema inspection, HTTP testing, AI grading, or something else.

**If unit tests cannot fully verify the concept** (e.g. testing that a model uses an index rather than a filter, or testing code organization patterns), **STOP and discuss with the user.** Present the options:

- Schema/index inspection (using `getSchema`, `hasIndexForFields`)
- AI grading (`createAIGraderTest`, currently disabled and requires a repo change to re-enable)
- AST analysis (parse the generated TypeScript files)
- Restructure the eval so the concept can be tested via behavior
- Accept the limitation and test what we can

Let the user decide before proceeding.

### Guidelines Hypothesis

Summarize the guideline context before implementation:

- Which existing guidelines are relevant to this eval
- What you would expect guideline-following models to do
- Whether failures on this eval would likely indicate a model gap, an eval/task problem, or a missing/weak guideline
- Any existing guideline that might need to be revised if calibration shows an unexpected result

If a new guideline is likely needed, design it **minimal-first**. Every token in the guidelines is sent with every prompt, so bloat costs real money. Start with the smallest guideline that teaches the critical pattern (usually one code example), test it, and only expand if models still fail. Avoid pinning specific dependency versions in guidelines as they age quickly. Prefer "always install the latest version" instead. Follow the guideline rules in AGENTS.md "Authoring New Evals": prove the line helps a specific eval, and prefer improving an existing line over adding one.

### Push Back

Before presenting the design, critically evaluate it. Warn the user if:

- The eval overlaps heavily with an existing eval (should have been caught in Step 1C, but re-check).
- The task tests too many concepts at once. Each eval should focus on one thing.
- The task is so explicit that it tells the model exactly how to solve it (e.g. specifying `.withIndex()` calls). We're testing knowledge, not instruction-following.
- The current guidelines suggest a different approach than the eval is rewarding, or make the expected signal unclear.
- The eval seems too easy (every model will pass) or too hard (no model will pass).

## Step 3: Implement the Eval

After the user approves the design, implement:

1. **Create directory:** `evals/<category>/<eval_slug>/`

2. **Write TASK.txt** with the approved content. For the static or module pipeline, also add `eval.json` (see "Eval Pipelines" in `reference.md`).

3. **Create answer directory:**
   - `answer/package.json`:
     ```json
     {
       "name": "convexbot",
       "version": "1.0.0",
       "dependencies": {
         "convex": "^1.31.2"
       }
     }
     ```
     Component evals pin exact versions of `convex` and the component instead (e.g. `"convex": "1.41.0"`, `"@convex-dev/aggregate": "0.2.2"`). Copy the pins from a sibling in `evals/007-components/`. Usage-eval tasks state the same pins. Selection-eval tasks can't name the component, so they pin only `convex`.
   - `answer/convex/schema.ts` (if applicable)
   - Implementation files (e.g. `answer/convex/index.ts`)
   - No `returns:` validators unless the task tests them (AGENTS.md). Answers are likely training data.

4. **Add generated types:** `bunx convex codegen` fails without a deployment ("No CONVEX_DEPLOYMENT set"). Copy `_generated` and `tsconfig.json` from a sibling single-module eval with the same files, e.g. `convex/index.ts` and `convex/schema.ts`:
   ```bash
   cp -R evals/<sibling>/answer/convex/_generated evals/<sibling>/answer/convex/tsconfig.json evals/<category>/<eval_slug>/answer/convex/
   ```
   See "Generated types" in `reference.md` for when to edit the copied imports.

5. **Write grader.test.ts** using the approved test approach. Backend-pipeline graders import from `grader/index.ts` with relative paths:
   ```typescript
   import { responseClient, responseAdminClient, addDocuments } from "../../../grader";
   import { api } from "./answer/convex/_generated/api";
   ```
   Adjust the depth of `../` based on the eval's nesting level. Static and module graders import from `../../../grader/outputDir` instead. `grader/index.ts` throws "CONVEX_PORT is not set" without a backend.

6. **Typecheck:**
   ```bash
   bun run typecheck
   ```

## Step 4: Validate the Answer

First run canonical answer validation for the new eval:

```bash
TEST_FILTER=<category>/<eval_slug> bun run validate:answers
```

### Cost approval

The smoke test below and Step 5 make paid model calls. Before running either, state a dollar estimate and wait for the user's approval. Take each model's average full-suite cost from the public production query `modelScores:getSchedulingStats`, as in the add-model skill:

```bash
URL=https://fabulous-panther-525.convex.cloud
for slug in anthropic/claude-sonnet-5 anthropic/claude-opus-4.8 openai/gpt-5.5 deepseek/deepseek-v4-pro; do
  ID=$(curl -s $URL/api/query -H 'Content-Type: application/json' \
    -d "{\"path\":\"models:getBySlug\",\"args\":{\"slug\":\"$slug\"}}" | jq -r .value._id)
  for exp in '' ',"experiment":"no_guidelines"'; do
    printf "%s%s " "$slug" "$exp"
    curl -s $URL/api/query -H 'Content-Type: application/json' \
      -d "{\"path\":\"modelScores:getSchedulingStats\",\"args\":{\"modelId\":\"$ID\"$exp}}" | jq .value.averageRunCostUsd
  done
done
```

Divide each average by the eval count (`ls -d evals/*/*/ | wc -l`) for a per-eval cost, sum over the models and conditions you'll run, and multiply by the repeats. On 2026-09-29 these four models averaged about $22.60 per default suite and $14 per `no_guidelines` suite over 112 evals, so one eval in both conditions cost about $0.33 per repeat, or $1 for three repeats. Evals with long tasks cost more.

### Smoke test

Run the eval for one model. This validates model generation against the new eval:

```bash
DISABLE_CONVEX_REPORTING=1 MODELS=anthropic/claude-sonnet-5 TEST_FILTER=<category>/<eval_slug> bun run local:run
```

`DISABLE_CONVEX_REPORTING=1` keeps results local.

If the smoke test fails:

1. Read the output directory and `run.log` to understand what happened.
2. Determine whether it's a **test problem** (fix the grader) or a **model problem** (expected, move on).
3. If the test itself is broken, fix it and re-run before proceeding.

## Step 5: Run Against Multiple Models

Start with a smaller representative set of models to calibrate difficulty. If the result is unclear, expand to a broader sweep. Use full OpenRouter slugs from `ALL_MODELS` in `runner/models/index.ts`. Run each model in both conditions, default and `EVALS_EXPERIMENT=no_guidelines`. The difference is the guidelines' measured contribution (AGENTS.md). Launch one background process per model:

```bash
# Suggested first-pass set
for m in anthropic/claude-sonnet-5 anthropic/claude-opus-4.8 openai/gpt-5.5 deepseek/deepseek-v4-pro; do
  (
    DISABLE_CONVEX_REPORTING=1 MODELS=$m TEST_FILTER=<category>/<eval_slug> bun run local:run
    DISABLE_CONVEX_REPORTING=1 EVALS_EXPERIMENT=no_guidelines MODELS=$m TEST_FILTER=<category>/<eval_slug> bun run local:run
  ) > "/tmp/calibrate-${m//\//_}.log" 2>&1 &
done
wait
```

If those results are too noisy or too uniform, expand to a broader sweep across providers and tiers from `ALL_MODELS`. The user can override the list. Any expansion needs a new estimate and approval.

Monitor progress by reading the log files. Each process runs one eval in two conditions, so they should complete in a few minutes.

### Run-to-run variance

Run each model **at least twice** (ideally three times) to distinguish systematic failures from flaky ones. Model output is non-deterministic, so a single pass or fail doesn't tell the whole story. Common variance sources:

- **Hallucinated dependency versions** that sometimes resolve and sometimes don't
- **Different code styles** across runs (e.g. one integration test vs many unit tests)
- **Different library version choices** from training data, where some versions have bugs

## Step 6: Review Results and Calibrate

Collect pass/fail from all model runs in both conditions and present a summary table:

```
Model                        default  no_guidelines
---------------------------  -------  -------------
anthropic/claude-sonnet-5    3/3      1/3
anthropic/claude-opus-4.8    3/3      2/3
openai/gpt-5.5               2/3      0/3
...
```

Then assess the results:

- **All pass** - The eval is likely too easy or the task is too explicit. Recommend tightening the task (remove implementation hints) or adding harder edge cases.
- **All fail** - The eval might be too hard, poorly specified, or testing something not covered by the guidelines. Investigate the failures. Common causes: ambiguous requirements, missing context, concept beyond current model capabilities.
- **Mixed results (ideal)** - The eval discriminates between model capabilities. Note whether the pass/fail pattern makes sense given model tiers.
- **Unexpected pattern** (e.g. only one provider's models fail) - Might indicate a provider-specific quirk rather than a meaningful eval. Investigate before keeping.

Then explicitly ask: is this primarily an **eval/task gap**, a **model gap**, or a **guideline gap**?

- **Eval/task gap** - The task is ambiguous, over-specified, under-specified, or the grader is not testing the right thing. Fix the eval first.
- **Model gap** - The task is sound, the grading is sound, and failures are what we would expect. Keep the eval.
- **Guideline gap** - The failures suggest there should be a guideline that helps here, or an existing guideline is weak/confusing/contradictory. If default and `no_guidelines` match, the current guidelines aren't moving this eval. After the eval is settled, recommend a change to `runner/models/guidelines.md` that follows AGENTS.md, then a regression check with the `validate-guidelines` skill filtered to this eval's category. That run needs its own cost estimate and approval.

### Debugging failures

Model output is preserved in the temp directory printed at the start of each run (`Using tempdir: ...`). These directories are NOT cleaned up automatically. For each model, look at:

- `<tempdir>/output/<provider>/<model>/<category>/<eval>/` for the generated source files
- `run.log` in that directory for step-by-step output (install, deploy, tsc, eslint, vitest)
- `node_modules/` for the actual resolved dependency versions
- `package.json` for what the model requested vs what was installed

This is essential for distinguishing "model wrote bad code" from "model's code is fine but the grader is too strict" from "dependency version bug".

**Push back** with specific recommendations if calibration looks off. Suggest concrete changes to the task, answer, or tests.

## Summary Checklist

- [ ] Concept and category confirmed with user
- [ ] Convex docs consulted for the feature being tested
- [ ] Relevant existing guidelines checked, with expected implications noted
- [ ] No significant overlap with existing evals (or overlap discussed with user)
- [ ] "Why this matters" written
- [ ] TASK.txt reviewed and approved by user before any files were created
- [ ] Test approach and pipeline discussed, especially if non-standard grading is needed
- [ ] Answer implemented and `_generated` copied from a sibling eval
- [ ] grader.test.ts written
- [ ] `bun run typecheck` passes
- [ ] `bun run validate:answers` passes for the new eval
- [ ] Smoke test passes for at least one model
- [ ] Cost estimate approved before any model run
- [ ] Calibrated on a representative set of models in both conditions, expanded if needed
- [ ] Results reviewed, including eval gap vs model gap vs guideline gap
- [ ] Difficulty is appropriate
