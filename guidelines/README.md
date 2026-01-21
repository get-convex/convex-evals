# Self-Improving Guideline Generation System

## Architecture Overview

```
flowchart TD
    subgraph orchestrator [Orchestrator Agent]
        Start[Start] --> ReadGuidelines[Read existing/checkpoint guidelines]
        ReadGuidelines --> RunEvals[Run all evals]
        RunEvals --> CheckResults{All pass?}
        CheckResults -->|No| CheckRegression{Regression?}
        CheckRegression -->|Yes| RevertCheckpoint[Revert to checkpoint]
        CheckRegression -->|No| UpdateCheckpoint[Update checkpoint if best]
        UpdateCheckpoint --> CheckPlateau{Good enough plateau?}
        CheckPlateau -->|Yes| CommitGuidelines[Commit as good enough]
        CheckPlateau -->|No| DispatchAnalyser[Dispatch FailureAnalyser]
        RevertCheckpoint --> RunEvals
        DispatchAnalyser --> MergeGuidelines[Incorporate suggestions]
        MergeGuidelines --> RunEvals
        CheckResults -->|Yes| ReliabilityCheck[Run 3x for reliability]
        ReliabilityCheck -->|All pass| RefinementPhase[Enter Refinement Phase]
        ReliabilityCheck -->|Some fail| DispatchAnalyser
        RefinementPhase --> ProposeRefinement[Propose refined guidelines]
        ProposeRefinement --> TestRefinement[Test refined guidelines 3x]
        TestRefinement -->|Pass| CommitRefinement[Commit refinement]
        TestRefinement -->|Fail| ProposeRefinement
        CommitRefinement --> RefinementLoop{10 failed attempts?}
        RefinementLoop -->|No| ProposeRefinement
        RefinementLoop -->|Yes| Complete[Complete]
    end

    subgraph analyser [FailureAnalyser Sub-Agent]
        ReceiveTask[Receive failed eval context] --> AnalyzeFiles[Analyze output vs expected]
        AnalyzeFiles --> SearchDocs[Search Convex docs if needed]
        SearchDocs --> CheckLegacy[Check legacy guidelines]
        CheckLegacy --> SuggestGuideline[Suggest guideline]
    end

    subgraph incorporator [Incorporator Sub-Agent]
        ReceiveAnalyses[Receive failure analyses] --> ReadHistory[Read iteration history]
        ReadHistory --> ResearchDocs[Research Convex docs]
        ResearchDocs --> SynthesizePatterns[Identify root causes]
        SynthesizePatterns --> GenerateGuidelines[Generate updated guidelines]
    end

    orchestrator --> analyser
    analyser --> incorporator
    incorporator --> orchestrator
```

## Directory Structure

```
guidelines/
  src/
    index.ts              # Interactive CLI entry point
    orchestrator.ts       # Main orchestrator agent (uses Claude Agent SDK)
    subagents.ts          # Subagent definitions (failure-analyser, incorporator)
    iterationHistory.ts   # Iteration history tracking
    evalRunner.ts         # Wrapper to spawn Python eval runner (legacy)
    guidelineStore.ts     # Read/write/merge guidelines
    lockFile.ts           # Lock file management
    logger.ts             # Verbose logging to console + file
    types.ts              # Shared types
  generated/                              # COMMITTED to git
    {provider}_{model}_guidelines.txt     # Working guidelines per model (committed as they improve)
  tmp/                                    # GITIGNORED - local temp files
    {provider}_{model}/                   # One folder per model
      .lock                               # Lock file with status JSON
      iteration_history.json              # Iteration history with eval-level results (persists across runs)
      checkpoint_guidelines.txt           # Best-known-good checkpoint (for regression recovery)
      {runId}/                            # Each run gets unique folder (for debug history)
        proposal_001.txt                  # Refinement proposals (kept for debugging)
        logs/
          orchestrator.log                # Verbose orchestrator log
        eval_output/                      # Passed to Python runner as OUTPUT_TEMPDIR
        results.jsonl                     # Eval results for this run
  .gitignore
  package.json
  tsconfig.json
```

## Key Features

### 1. Working Guidelines in Git

Working guidelines live at `generated/{provider}_{model}_guidelines.txt` so they can be committed to git as they improve. This means:
- Guidelines persist across runs and are iterated upon
- Progress can be tracked and committed to version control
- Only refinement proposals and temp files are written to run-specific directories
- Easier to resume and inspect current state

### 2. Checkpointing and Regression Recovery

- **Checkpoint file**: `tmp/{provider}_{model}/checkpoint_guidelines.txt` stores best-known-good guidelines
- **Regression detection**: If pass count drops by more than 2 evals, revert to checkpoint
- **Automatic checkpointing**: When a new best pass count is achieved, save as checkpoint

### 3. "Good Enough" Threshold

Instead of requiring 100% pass rate (which may be impossible for weaker models):
- **90% pass rate threshold**: Accept if we reach 90% and maintain it
- **Stable plateau detection**: Must sustain the same pass count for 5 consecutive iterations
- **Graceful exit**: If max iterations reached but above threshold, commit anyway

### 4. Content Truncation

Failure analyzer truncates large contexts to prevent token limit errors:
- Max 15,000 chars per file
- Max 10,000 chars for run logs (keeps the end where errors are)
- Max 20,000 chars for legacy guidelines

### 5. Confidence Filtering

Only incorporate high/medium confidence suggestions from failure analysis. Low confidence suggestions are logged but ignored.

### 6. No Numbering in Guidelines

Guidelines use markdown headers (##) for topics and bullet points (-) for individual guidelines, not numbered lists. This makes merging and deduplication easier.

### 7. Incorporator Sub-Agent with Iteration History

The incorporator is a dedicated sub-agent that synthesizes failure analyses into guidelines:

- **Research capabilities**: Has web search access to Convex docs (like the failure analyser)
- **Pattern recognition**: Groups failures by category and identifies root causes
- **Iteration history**: Receives feedback on what changes worked or caused regressions in previous iterations
- **Learning**: Can see which evals started passing or regressed after guideline changes
- **History persistence**: Iteration history is saved in `tmp/{provider}_{model}/iteration_history.json` and persists across runs

The incorporator receives:
- Current guidelines
- Failure analyses grouped by category (pagination, imports, storage, etc.)
- Iteration history showing what changed and what outcomes resulted
- Legacy guidelines for reference

This enables the system to learn from past iterations and progressively improve guidelines based on what actually works.

## Configuration Constants

```typescript
MAX_CONSTRUCTION_ITERATIONS = 50     // Safety limit
MIN_PASS_RATE_THRESHOLD = 0.90       // 90% is "good enough"
STABLE_PLATEAU_ITERATIONS = 5        // Must sustain for 5 iterations
MAX_REGRESSION_ALLOWED = 2           // Revert if we lose >2 passing evals
STABILITY_CHECK_RUNS = 3             // Reliability check runs
```

## Algorithm Details

### File Locations

- **Working guidelines**: `guidelines/generated/{provider}_{model}_guidelines.txt` (committed to git as they improve)
- **Lock file**: `guidelines/tmp/{provider}_{model}/.lock` (status JSON, persists across runs)
- **Iteration history**: `guidelines/tmp/{provider}_{model}/iteration_history.json` (tracks eval-level results per iteration, persists across runs)
- **Checkpoint**: `guidelines/tmp/{provider}_{model}/checkpoint_guidelines.txt` (best-known-good, for regression recovery)
- **Proposal files**: `guidelines/tmp/{provider}_{model}/{runId}/proposal_NNN.txt`
- **Eval output**: `guidelines/tmp/{provider}_{model}/{runId}/eval_output/`
- **Logs**: `guidelines/tmp/{provider}_{model}/{runId}/logs/`

### Startup

1. Generate new `runId` (timestamp-based, sortable)
2. Check lock file - if PID still running, exit with error
3. Write lock file with initial status
4. Create run directory for logs
5. Initialize working guidelines from: existing working > checkpoint > committed > empty
6. Begin Construction Phase

### Construction Phase

1. Run all evals using working guidelines
2. Check for 100% pass → reliability check → refinement phase
3. Check for regression → revert to checkpoint if dropped more than 2
4. Update checkpoint if new best achieved
5. Check for "good enough" plateau → commit if 90%+ for 5 iterations
6. Save iteration record with eval-level results to history
7. Analyze failures (high/medium confidence only)
8. Incorporate suggestions using incorporator sub-agent (with iteration history feedback)
9. Update iteration record with guideline changes summary
10. Loop back to step 1

### Refinement Phase

1. Read current committed guidelines
2. Propose a refinement (remove/combine/simplify)
3. Write proposal to `{runId}/proposal_NNN.txt`
4. Test 3x with proposal
5. If all pass: commit and continue
6. If fail: keep proposal for debugging, try different refinement
7. Exit after 10 consecutive failed attempts

## Lock File Schema

```json
{
  "runId": "2026-01-20_15-11-57_77df",
  "pid": 12345,
  "startedAt": "2026-01-20T10:30:00Z",
  "phase": "construction",
  "iteration": 3,
  "lastEvalResult": {
    "passed": 60,
    "failed": 6,
    "total": 66
  },
  "currentAction": "analyzing failures",
  "updatedAt": "2026-01-20T11:45:00Z",
  "bestPassCount": 60,
  "bestIteration": 3,
  "stableIterations": 2
}
```

## Guideline Output Format

Guidelines use markdown with topic headers and bullet points (no numbering):

```markdown
# Convex Code Generation Guidelines

## Imports and Type Definitions

- Import `Id` and `Doc` types from `./_generated/dataModel`, NEVER from `convex` or `convex/server`
- Import `api` and `internal` from `./_generated/api` for function references

## Function Definitions

- ALWAYS include `args` and `returns` validators for ALL Convex functions
- Use `returns: v.null()` if nothing is returned, and explicitly return `null`

## Database Operations

- Use `ctx.db.patch(id, fields)` for partial updates—there is NO `ctx.db.update()`
- Always terminate queries with `.collect()`, `.first()`, `.unique()`, or `.take(n)`
```

## Usage

```bash
# Start guidelines generation for a model
bun run generate-guidelines --model gpt-5-mini --provider openai

# View status
bun run generate-guidelines status

# Clean old runs
bun run generate-guidelines clean --model gpt-5 --keep 3
```

## Environment Variables

The Python runner is configured via environment variables:

- `CUSTOM_GUIDELINES_PATH` - Path to guidelines file to use instead of default
- `OUTPUT_TEMPDIR` - Where to write eval output
- `LOCAL_RESULTS` - Where to write results JSONL

## Dependencies

```json
{
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "^0.2.14",
    "@inquirer/prompts": "^7.2.1",
    "commander": "^13.0.0",
    "dotenv": "^16.4.0"
  }
}
```

## Architecture: Claude Agent SDK

The orchestrator uses the Claude Agent SDK V2 interface for session-based agent interactions:

- **Main orchestrator**: A Claude Opus agent with access to Read, Write, Bash, Glob, Grep, and Task tools
- **Subagents**: Defined programmatically via the `agents` parameter:
  - `failure-analyser`: Analyzes individual eval failures (Claude Sonnet)
  - `incorporator`: Synthesizes analyses into guidelines (Claude Opus)

The orchestrator receives a comprehensive prompt with the algorithm, file paths, and decision criteria. It autonomously runs evals, analyzes failures via subagents, and updates guidelines.

## Future: Combining Guidelines

Once we have good per-model guidelines, a separate `combineGuidelines.ts` script can:

1. Load all `{provider}_{model}_guidelines.txt` files
2. Identify common guidelines across models (intersection)
3. Identify model-specific guidelines
4. Propose combined outputs:
    - `essential_guidelines.txt` - works for all top models
    - `full_guidelines.txt` - comprehensive for weaker models
    - `{model}_specific.txt` - additions needed for specific model
