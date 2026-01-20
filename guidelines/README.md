# Self-Improving Guideline Generation System

This system automatically generates and refines model-specific guidelines for Convex code generation by running evals, analyzing failures, and iteratively improving guidelines.

## Quick Start

```bash
# Interactive menu
bun run generate-guidelines

# Start directly for a specific model
bun run generate-guidelines --model anthropic/claude-sonnet-4-5

# View status of all models
bun run generate-guidelines status

# View run history
bun run generate-guidelines history --model anthropic/claude-sonnet-4-5

# Clean old temp files
bun run generate-guidelines clean --model anthropic/claude-sonnet-4-5 --keep 3
```

## How It Works

### Construction Phase

1. Starts with committed guidelines (or empty if none exist)
2. Runs all evals with current guidelines
3. For each failure, dispatches a FailureAnalyser sub-agent to suggest a guideline
4. Incorporates suggestions and updates working guidelines
5. Repeats until all evals pass 3 times consecutively
6. Commits successful guidelines to `generated/{provider}_{model}_guidelines.txt`

### Refinement Phase

1. Proposes refinements to reduce token count while maintaining effectiveness
2. Tests each proposal 3 times to ensure reliability
3. Commits successful refinements
4. Continues until 10 consecutive refinement attempts fail
5. Failed proposals are kept for debugging

## Directory Structure

```
guidelines/
  src/                       # TypeScript source code
    index.ts                 # Interactive CLI entry point
    orchestrator.ts          # Main orchestrator agent
    failureAnalyser.ts       # Failure analysis sub-agent
    evalRunner.ts            # Wrapper to spawn Python eval runner
    guidelineStore.ts        # Read/write/merge guidelines
    lockFile.ts              # Lock file utilities
    logger.ts                # Logging to console + file
    types.ts                 # Shared types
  generated/                 # COMMITTED to git
    {provider}_{model}_guidelines.txt  # Final guidelines per model
  tmp/                       # GITIGNORED - local temp files
    {provider}_{model}/      # One folder per model
      .lock                  # Lock file with status JSON
      {runId}/               # Each run gets unique folder
        working_guidelines.txt       # Current working copy
        proposal_001.txt             # Refinement proposals
        logs/
          orchestrator.log           # Verbose orchestrator log
        eval_output/                 # Passed to Python runner
        results.jsonl                # Eval results
```

## Lock File

Each model has a lock file (`tmp/{provider}_{model}/.lock`) that:
- Prevents duplicate runs for the same model
- Provides real-time status for the CLI
- Persists across runs for resumability

Lock file structure:
```json
{
  "runId": "a1b2c3d4-5678-90ab-cdef",
  "pid": 12345,
  "startedAt": "2025-01-20T10:30:00Z",
  "phase": "construction",
  "iteration": 3,
  "lastEvalResult": {
    "passed": 138,
    "failed": 4,
    "total": 142
  },
  "currentAction": "analyzing failures",
  "updatedAt": "2025-01-20T11:45:00Z"
}
```

## Resumability

- Stop and restart anytime
- Orchestrator always begins in Construction Phase
- Loads committed guidelines from `generated/` and continues
- If guidelines are already solid, construction passes quickly and proceeds to refinement
- Previous run folders preserved for debugging

## Parallel Safety

- Run multiple models simultaneously without interference
- Each model has its own lock file and temp directory
- Safe to run `claude-sonnet-4-5` and `gpt-5` at the same time

## Environment Variables

The Python eval runner is configured via environment variables:
- `CUSTOM_GUIDELINES_PATH` - Path to guidelines file (working or proposal)
- `OUTPUT_TEMPDIR` - Where to write eval output
- `LOCAL_RESULTS` - Where to write results JSONL
- `DISABLE_BRAINTRUST=1` - Disable Braintrust proxy
- `VERBOSE_INFO_LOGS=1` - Enable verbose logging

## Architecture

The system uses two AI agents:

### Orchestrator Agent
- Manages the overall construction and refinement process
- Runs evals via Python runner
- Coordinates failure analysis
- Incorporates suggestions
- Proposes and tests refinements

### FailureAnalyser Sub-Agent
- Receives context about a failed eval
- Analyzes what went wrong
- Suggests a guideline to prevent the failure
- References legacy guidelines when relevant

Both agents use Claude Sonnet 4 via the Vercel AI SDK.

## Guidelines Format

Generated guidelines are saved to `generated/{provider}_{model}_guidelines.txt`:

```markdown
# Convex Guidelines for {Model Name}

## Function Syntax
- ALWAYS use the new function syntax with `query({...})` not `export const q = query(...)`
- Include `returns` validator even when returning null: `returns: v.null()`

## Schema
- Define schema in `convex/schema.ts` using `defineSchema` and `defineTable`
...
```

## Debugging

All temp files are kept in the repo for easy inspection:
- View logs: `cat guidelines/tmp/{provider}_{model}/{runId}/logs/orchestrator.log`
- View eval output: `ls guidelines/tmp/{provider}_{model}/{runId}/eval_output/`
- View proposals: `cat guidelines/tmp/{provider}_{model}/{runId}/proposal_*.txt`
- View run history: `bun run generate-guidelines history --model {provider}/{model}`

## Cleaning Up

```bash
# Clean specific model, keep 3 most recent runs
bun run generate-guidelines clean --model anthropic/claude-sonnet-4-5 --keep 3

# Clean all temp files
bun run generate-guidelines clean
```

## Future: Combining Guidelines

Once per-model guidelines are solid, a separate script can:
1. Load all model guidelines
2. Identify common guidelines (intersection)
3. Identify model-specific guidelines
4. Propose combined outputs:
   - `essential_guidelines.txt` - works for all top models
   - `full_guidelines.txt` - comprehensive for weaker models
   - `{model}_specific.txt` - additions for specific model
