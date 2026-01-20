# Self-Improving Guideline Generation System

## Architecture Overview

```
flowchart TD
    subgraph orchestrator [Orchestrator Agent]
        Start[Start] --> ReadGuidelines[Read existing guidelines]
        ReadGuidelines --> RunEvals[Run all evals]
        RunEvals --> CheckResults{All pass?}
        CheckResults -->|No| DispatchAnalyser[Dispatch FailureAnalyser for each failure]
        DispatchAnalyser --> MergeGuidelines[Incorporate suggested guidelines]
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

    orchestrator --> analyser
    analyser --> orchestrator


```

## Directory Structure

```
guidelines/
  src/
    index.ts              # Interactive CLI entry point (like runEvals.ts)
    orchestrator.ts       # Main orchestrator agent
    failureAnalyser.ts    # Failure analysis sub-agent
    evalRunner.ts         # Wrapper to spawn Python eval runner
    guidelineStore.ts     # Read/write/merge guidelines
    logger.ts             # Verbose logging to console + file
    tools/
      readFile.ts         # Tool to read files
      webSearch.ts        # Tool to search web/docs
      legacyGuidelines.ts # Tool to access current guidelines.py
    types.ts              # Shared types
  generated/                              # COMMITTED to git (user reviews and commits)
    {provider}_{model}_guidelines.txt     # Final guidelines per model
  tmp/                                    # GITIGNORED - local temp files for easy browsing
    {provider}_{model}/                   # One folder per model
      .lock                               # Lock file with status JSON (persists across runs)
      {runId}/                            # Each run gets unique folder (UUID, for debug history)
        working_guidelines.txt            # Current working copy for this run
        proposal_001.txt                  # Refinement proposals (kept for debugging)
        proposal_002.txt                  # All proposals kept, not deleted on failure
        logs/
          orchestrator.log                # Verbose orchestrator log
          eval_run_001.log                # Per-eval-run logs
        eval_output/                      # Passed to Python runner as OUTPUT_TEMPDIR
        results.jsonl                     # Eval results for this run
  .gitignore
  package.json
  tsconfig.json


```

**guidelines/.gitignore:**

```
tmp/
node_modules/


```

## Model-Based Isolation (Parallel Safety + Resumability)

Each model gets its own folder under `tmp/{provider}_{model}/` with:

- A **lock file** (`.lock`) at the model level - persists across runs
- A **runId folder** for each orchestrator session - preserves debug history

This provides:

1. **Parallel safety**: Run `claude-sonnet-4-5` and `gpt-5` simultaneously without interference
2. **Resumability**: Stop and restart anytime - orchestrator reads from `generated/` and continues
3. **Debug history**: Previous runs preserved in their runId folders for inspection
4. **Easy browsing**: All temp files are in the repo, easy to inspect logs and outputs

**Lock file (`tmp/{provider}_{model}/.lock`):**

The lock file serves dual purpose - prevents duplicate runs AND provides status for the CLI.

The orchestrator updates this file after each significant action (eval run, phase change, etc.):

```
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

The CLI reads this file to display real-time status. If the PID is no longer running, it shows as "paused".

**Resumability behavior:**

- On startup, orchestrator always begins in **Construction Phase**
- Checks lock file - if PID still running, exits with error (duplicate prevention)
- Creates new runId folder for this session's temp files
- Loads guidelines from `generated/{provider}_{model}_guidelines.txt` (if exists) or starts empty
- If guidelines are already solid (from previous refinement), construction will pass 3x quickly
- Then automatically proceeds to Refinement Phase
- Previous run folders remain for debugging

**Refinement proposals:**

- During refinement, proposals are written to `tmp/{provider}_{model}/{runId}/proposal_NNN.txt`
- The `CUSTOM_GUIDELINES_PATH` env var points to the proposal file being tested
- If proposal passes 3x: copy to `generated/`
- Failed proposals are **kept** (not deleted) for debugging
- Committed guidelines in `generated/` are only updated on success

The Python runner is configured via environment variables only - no code modification during runs:

- `CUSTOM_GUIDELINES_PATH` - Path to guidelines file to use instead of default
- `OUTPUT_TEMPDIR` - Where to write eval output (already supported)
- `LOCAL_RESULTS` - Where to write results JSONL (already supported)

## Key Components

### 1. Interactive CLI (guidelines/src/index.ts)

Modeled after scripts/runEvals.ts - an interactive CLI using `@inquirer/prompts`.

**Usage:** `bun run generate-guidelines` (add script to root package.json)

**Interactive flow:**

```
🧪 Convex Guidelines Generator

Current Status:
  claude-sonnet-4-5    ✅ 100% (142 evals) - 847 tokens
  gpt-5                🔄 Running... (iteration 3)
  gemini-2.5-pro       ⏸️  Paused at 94% - 1,203 tokens
  grok-4               ❌ Not started

? What would you like to do?
  > Start/resume guidelines generation
    View model status (detailed)
    View run history for a model
    View logs for a model
    Clean temp files
    Exit

? Select model to work on:
  > claude-sonnet-4-5 (✅ complete)
    gpt-5 (🔄 running)
    gemini-2.5-pro (⏸️ paused)
    grok-4 (not started)
    [Enter custom model name]


```

**Status detection (reads from lock file `tmp/{provider}_{model}/.lock`):**

- **Running**: Lock file exists AND PID is still alive → shows phase, iteration, last eval results
- **Paused**: Lock file exists BUT PID is dead → shows last known state, "paused"
- **Complete**: `generated/{provider}_{model}_guidelines.txt` exists, no lock file
- **Not started**: No guidelines file, no lock file

The lock file contains all the info needed to display detailed status:

```
{
  "runId": "a1b2c3d4",
  "pid": 12345,
  "phase": "construction",
  "iteration": 3,
  "lastEvalResult": { "passed": 138, "failed": 4, "total": 142 },
  "currentAction": "analyzing failures",
  "updatedAt": "2025-01-20T11:45:00Z"
}


```

**CLI Commands (non-interactive):**

```
# Start directly for a model
bun run generate-guidelines --model claude-sonnet-4-5

# View status of all models
bun run generate-guidelines status

# View run history for a model (lists runId folders)
bun run generate-guidelines history --model claude-sonnet-4-5

# Clean all temp files (removes all runId folders)
bun run generate-guidelines clean

# Clean temp for specific model
bun run generate-guidelines clean --model gpt-5

# Clean old runs, keep only the most recent N
bun run generate-guidelines clean --model gpt-5 --keep 3


```

### 2. Orchestrator Agent (guidelines/src/orchestrator.ts)

The orchestrator uses the Vercel AI SDK with tool calling. It will be given these tools:

- `runEvals(model, filter?)` - Run evals via Python runner, returns results
- `readGuidelines(model)` - Read current guidelines file
- `writeGuidelines(model, content)` - Write guidelines file
- `dispatchFailureAnalyser(evalName, context)` - Spawn sub-agent for a failed eval
- `log(message)` - Log to console and file

The orchestrator prompt should instruct it to:

1. Construction Phase: Start with empty/minimal guidelines, analyze failures, add guidelines, repeat until all pass 3x
2. Refinement Phase: Try to reduce/simplify guidelines while maintaining 3x pass rate

### 3. FailureAnalyser Sub-Agent (guidelines/src/failureAnalyser.ts)

Receives context:

- TASK.txt content
- Expected answer files (concatenated)
- Model output files (concatenated)
- run.log content

Has tools:

- `readFile(path)` - Read any file (tests, answer files, etc.)
- `searchConvexDocs(query)` - Search docs.convex.dev
- `getLegacyGuidelines(section?)` - Access current guidelines.py content
- `searchStackPosts(query)` - Search Convex stack posts

Returns a structured response:

```
{
  analysis: string;           // What went wrong
  suggestedGuideline: string; // The guideline text
  confidence: 'high' | 'medium' | 'low';
  relatedLegacyGuidelines: string[];  // Which existing guidelines are relevant
}


```

### 4. Eval Runner Wrapper (guidelines/src/evalRunner.ts)

Wraps the existing Python runner. The TypeScript code treats Python as read-only and configures behavior entirely via environment variables:

```
async function runEvals(options: {
  model: string;
  provider: string;
  runId: string;              // Current orchestrator run ID
  filter?: string;
  guidelinesPath: string;     // Path to working_guidelines.txt or proposal file
}): Promise<EvalRunResult> {
  // Run-specific temp directory (inside repo for easy browsing)
  const modelSlug = `${options.provider}_${sanitizeModelName(options.model)}`;
  const runDir = join(__dirname, '..', 'tmp', modelSlug, options.runId);
  const outputDir = join(runDir, 'eval_output');
  const resultsPath = join(runDir, 'results.jsonl');

  await mkdir(outputDir, { recursive: true });

  const env = {
    ...process.env,
    MODELS: options.model,
    TEST_FILTER: options.filter ?? '',
    CUSTOM_GUIDELINES_PATH: options.guidelinesPath,  // Points to working or proposal file
    OUTPUT_TEMPDIR: outputDir,
    LOCAL_RESULTS: resultsPath,
    DISABLE_BRAINTRUST: '1',
    VERBOSE_INFO_LOGS: '1',
  };

  // Spawn Python runner - no code modifications
  await spawn('pdm', ['run', 'python', '-m', 'runner.eval_convex_coding'], { env });

  // Parse results from this run's results file
  return parseResults(resultsPath);
}

function sanitizeModelName(model: string): string {
  // "claude-sonnet-4-5" -> "claude-sonnet-4-5"
  // "meta-llama/Meta-Llama-3.1-405B" -> "meta-llama_Meta-Llama-3.1-405B"
  return model.replace(/\\\\//g, '_');
}


```

### 5. Python Changes Required (One-Time Setup)

Add support for `CUSTOM_GUIDELINES_PATH` env var in runner/models/model_codegen.py. This is a one-time change, not modified during agent runs:

```
def get_guidelines_content() -> str:
    """Get guidelines content from custom file or default."""
    custom_path = os.getenv("CUSTOM_GUIDELINES_PATH")
    if custom_path and os.path.exists(custom_path):
        with open(custom_path, "r") as f:
            return f.read()
    if should_skip_guidelines():
        return ""
    return "".join(render_guidelines(CONVEX_GUIDELINES))


```

Then update `render_prompt()` to use this function instead of directly calling `render_guidelines()`.

### 6. Logger (guidelines/src/logger.ts)

```
class Logger {
  constructor(private logPath: string) {}

  log(level: 'info' | 'debug' | 'step', message: string, data?: object) {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] [${level.toUpperCase()}] ${message}`;

    // Always log to console
    console.log(line);
    if (data) console.log(JSON.stringify(data, null, 2));

    // Append to log file
    appendFileSync(this.logPath, line + '\\\\n');
    if (data) appendFileSync(this.logPath, JSON.stringify(data, null, 2) + '\\\\n');
  }
}


```

## Algorithm Details

### File Locations

- **Committed guidelines**: `guidelines/generated/{provider}_{model}_guidelines.txt` (checked into git)
- **Lock file**: `guidelines/tmp/{provider}_{model}/.lock` (status JSON, persists across runs)
- **Working guidelines**: `guidelines/tmp/{provider}_{model}/{runId}/working_guidelines.txt`
- **Proposal files**: `guidelines/tmp/{provider}_{model}/{runId}/proposal_NNN.txt`
- **Eval output**: `guidelines/tmp/{provider}_{model}/{runId}/eval_output/`
- **Logs**: `guidelines/tmp/{provider}_{model}/{runId}/logs/`

### Startup (Always Construction Phase)

1. Generate new `runId` (UUID)
2. Check lock file `tmp/{provider}_{model}/.lock`:

    - If exists and PID is still running → exit with error (duplicate prevention)
    - Otherwise → proceed

3. Write lock file with initial status (runId, pid, startedAt, phase: "startup")
4. Create run directory `tmp/{provider}_{model}/{runId}/`
5. Copy committed guidelines to `{runId}/working_guidelines.txt` (or create empty if none exists)
6. Update lock file: phase = "construction"
7. Begin Construction Phase

### Construction Phase

1. Run all evals for target model using `{runId}/working_guidelines.txt`
2. Update lock file with eval results and iteration count
3. If all pass: run 2 more times (3 total) for reliability
4. If all 3 runs pass:

    - Copy working guidelines to committed location
    - Update lock file: phase = "refinement"
    - Proceed to Refinement Phase

5. If any failures:

    - Update lock file: currentAction = "analyzing failures"
    - For each failing eval:
        - Gather context (TASK, expected, output, run.log) from `{runId}/eval_output/`
        - Dispatch FailureAnalyser
        - Collect suggested guideline
    - Update lock file: currentAction = "incorporating suggestions"
    - Orchestrator reviews all suggestions and:
        - Deduplicates similar guidelines
        - Resolves conflicts
        - Minimizes token count
        - Updates `{runId}/working_guidelines.txt`
    - Loop back to step 1

### Refinement Phase

1. Start with clean agent context (new conversation)
2. Read current committed guidelines
3. Orchestrator proposes a refinement:

    - Remove a guideline it suspects is unnecessary
    - Combine overlapping guidelines
    - Simplify wording while preserving meaning

4. Write proposal to `{runId}/proposal_NNN.txt` (incrementing counter)
5. Update lock file: currentAction = "testing proposal NNN"
6. Run all evals 3x with `CUSTOM_GUIDELINES_PATH` pointing to the proposal file
7. If all 3 runs pass:

    - Copy proposal to committed location
    - Reset failed attempts counter
    - Update lock file with success
    - Loop to step 3

8. If any fail:

    - **Keep** the failed proposal file (for debugging)
    - Increment failed attempts counter
    - Update lock file with failure info
    - Loop to step 3 with different refinement strategy

9. After 10 consecutive failed refinement attempts:

    - Log completion message
    - Update lock file: phase = "complete"
    - Remove lock file
    - Exit

### Cleanup on Exit

- Remove lock file `tmp/{provider}_{model}/.lock`
- Temp files in `{runId}/` folders remain for user inspection
- User cleans periodically via CLI command: `bun run generate-guidelines clean`

### Guideline Merging Strategy

When incorporating new guidelines, the orchestrator should:

- Check for semantic overlap with existing guidelines
- Prefer specific examples over abstract rules
- Keep guidelines focused on one concept each
- Target approximately 50-100 tokens per guideline
- Order guidelines from most to least commonly needed

## Output Format

Generated guidelines are saved to `guidelines/generated/{provider}_{model}_guidelines.txt` (committed to git).

The user will periodically review and commit these files - the agent does not commit.

```
# Convex Guidelines for {Model Name}

## Function Syntax
- ALWAYS use the new function syntax with `query({...})` not `export const q = query(...)`
- Include `returns` validator even when returning null: `returns: v.null()`

## Schema
- Define schema in `convex/schema.ts` using `defineSchema` and `defineTable`
...


```

## Dependencies

Add to guidelines/package.json:

```
{
  "dependencies": {
    "ai": "^5.0.76",
    "@ai-sdk/anthropic": "^1.0.0",
    "zod": "^3.23.0",
    "commander": "^13.0.0"
  }
}


```

## Future: Combining Guidelines

Once we have good per-model guidelines, a separate `combineGuidelines.ts` script can:

1. Load all `{provider}_{model}_guidelines.txt` files
2. Identify common guidelines across models (intersection)
3. Identify model-specific guidelines
4. Propose combined outputs:

    - `essential_guidelines.txt` - works for all top models
    - `full_guidelines.txt` - comprehensive for weaker models
    - `{model}_specific.txt` - additions needed for specific model