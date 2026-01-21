import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { randomBytes } from 'crypto';
import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';

import type { LockFileStatus, IterationFeedback } from './types.js';
import { Logger } from './logger.js';
import {
  readGuidelines,
  getRunDir,
  getWorkingGuidelinesPath,
  getCheckpointPath,
  getTmpModelDir,
  getCommittedGuidelinesPath,
  readWorkingGuidelines,
  writeWorkingGuidelines,
  readCheckpoint,
} from './guidelineStore.js';
import { readLockFile, writeLockFile, deleteLockFile, isProcessRunning } from './lockFile.js';
import {
  readIterationHistory,
  getRecentIterationFeedback,
} from './iterationHistory.js';
import { failureAnalyserAgent, incorporatorAgent } from './subagents.js';
import { createOrchestratorTools } from './tools.js';

// ============================================================================
// Configuration Constants
// ============================================================================

const MAX_CONSTRUCTION_ITERATIONS = 50;
const MIN_PASS_RATE_THRESHOLD = 0.90; // 90%
const STABLE_PLATEAU_ITERATIONS = 5;
const MAX_REGRESSION_ALLOWED = 2;
const STABILITY_CHECK_RUNS = 3;

// ============================================================================
// Types
// ============================================================================

export interface OrchestratorOptions {
  model: string;
  provider: string;
  filter?: string;
}

// ============================================================================
// Main Entry Point
// ============================================================================

/**
 * Generate a human-readable, sortable run ID.
 * Format: YYYY-MM-DD_HH-mm-ss_xxxx (sorts alphabetically by date/time, uses UTC)
 */
function generateRunId(): string {
  const now = new Date();
  const iso = now.toISOString();
  const date = iso.slice(0, 10); // YYYY-MM-DD
  const time = iso.slice(11, 19).replace(/:/g, '-'); // HH-mm-ss
  const random = randomBytes(2).toString('hex');
  return `${date}_${time}_${random}`;
}

export async function runOrchestrator(options: OrchestratorOptions): Promise<void> {
  const runId = generateRunId();
  const logger = setupLogger(options.provider, options.model, runId);

  logger.step(`Starting orchestrator for ${options.provider}/${options.model}`);
  logger.info(`Run ID: ${runId}`);

  // Check for existing lock
  const existingLock = readLockFile(options.provider, options.model);
  if (existingLock && isProcessRunning(existingLock.pid)) {
    throw new Error(
      `Another orchestrator is already running for this model (PID ${existingLock.pid})`
    );
  }

  // Create lock file
  const lockStatus: LockFileStatus = {
    runId,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    phase: 'startup',
    iteration: 0,
    updatedAt: new Date().toISOString(),
    bestPassCount: 0,
    bestIteration: 0,
    stableIterations: 0,
  };
  writeLockFile(options.provider, options.model, lockStatus);

  try {
    // Create run directory for logs
    const runDir = getRunDir(options.provider, options.model, runId);
    mkdirSync(join(runDir, 'logs'), { recursive: true });

    // Initialize working guidelines
    const committedGuidelines = readGuidelines(options.provider, options.model);
    const checkpointGuidelines = readCheckpoint(options.provider, options.model);
    const existingWorking = readWorkingGuidelines(options.provider, options.model);

    // Priority: existing working > checkpoint > committed > empty
    const startingGuidelines = existingWorking || checkpointGuidelines || committedGuidelines;

    if (!existingWorking && startingGuidelines) {
      writeWorkingGuidelines(options.provider, options.model, startingGuidelines);
    }

    const source = existingWorking
      ? 'existing working'
      : checkpointGuidelines
        ? 'checkpoint'
        : committedGuidelines
          ? 'committed'
          : 'empty';
    logger.info(`Starting with ${source} guidelines`);

    // Build orchestrator prompt with full context
    const prompt = buildOrchestratorPrompt(options, runId, lockStatus);

    // Create custom tools for the orchestrator
    const toolsWorkspaceRoot = join(import.meta.dir, '..', '..');
    const toolsRunDir = getRunDir(options.provider, options.model, runId);
    const toolsResultsPath = join(toolsRunDir, 'results.jsonl');
    const toolsOutputDir = join(toolsRunDir, 'eval_output');
    const orchestratorTools = createOrchestratorTools(
      toolsWorkspaceRoot,
      toolsOutputDir,
      toolsResultsPath,
      options.model
    );

    // Create query with subagents and custom tools using V1 API
    logger.step('Starting orchestrator agent query');

    const q = query({
      prompt,
      options: {
        model: 'claude-opus-4-5',
        allowedTools: [
          // Built-in tools
          'Read',
          'Write',
          'Bash',
          'Glob',
          'Grep',
          'Task',
          // MCP orchestrator tools (must be explicitly allowed)
          'mcp__orchestrator-tools__GetEvalSummary',
          'mcp__orchestrator-tools__GetFailedEvalDetails',
          'mcp__orchestrator-tools__GetRunLogError',
          'mcp__orchestrator-tools__GroupFailuresByPattern',
          'mcp__orchestrator-tools__SaveCheckpoint',
          'mcp__orchestrator-tools__RevertToCheckpoint',
          'mcp__orchestrator-tools__GetLegacyGuidelines',
        ],
        mcpServers: {
          'orchestrator-tools': orchestratorTools,
        },
        agents: {
          'failure-analyser': failureAnalyserAgent,
          'incorporator': incorporatorAgent,
        },
      },
    });

    // Stream responses and log progress
    for await (const msg of q) {
      // Log all messages to detailed log
      logger.detailed(`Message type: ${msg.type}`, msg);

      if (msg.type === 'assistant') {
        type ContentBlock = { type: string; text?: string; name?: string; input?: unknown };
        type Usage = {
          input_tokens?: number;
          output_tokens?: number;
          cache_read_input_tokens?: number;
          cache_creation_input_tokens?: number;
        };
        const assistantMsg = msg as SDKMessage & {
          message: { content: ContentBlock[]; usage?: Usage };
        };

        // Log token usage if available
        // Note: input_tokens is just the non-cached portion, cache_read_input_tokens and
        // cache_creation_input_tokens contain the actual cached context tokens
        const usage = assistantMsg.message.usage;
        if (usage) {
          const inputTokens = usage.input_tokens ?? 0;
          const cacheReadTokens = usage.cache_read_input_tokens ?? 0;
          const cacheCreationTokens = usage.cache_creation_input_tokens ?? 0;
          const outputTokens = usage.output_tokens ?? 0;
          // Total context = non-cached input + cache read + cache creation + output
          const totalContextInput = inputTokens + cacheReadTokens + cacheCreationTokens;
          logger.tokens(totalContextInput, outputTokens, cacheReadTokens, cacheCreationTokens);
        }

        // Extract and log text content
        const textBlocks = assistantMsg.message.content.filter(
          (block: ContentBlock): block is ContentBlock & { type: 'text'; text: string } =>
            block.type === 'text' && typeof block.text === 'string'
        );
        const text = textBlocks.map((block: ContentBlock & { text: string }) => block.text).join('');
        if (text) {
          logger.info('Agent:', { text: text.slice(0, 500) });
        }

        // Extract and log tool use blocks
        const toolBlocks = assistantMsg.message.content.filter(
          (block: ContentBlock) => block.type === 'tool_use'
        );
        for (const toolBlock of toolBlocks) {
          const tb = toolBlock as ContentBlock & { name: string; input: unknown };
          logger.tool(tb.name, tb.input as object);
        }
      }

      // Log tool progress (for long-running tools like Bash)
      if (msg.type === 'tool_progress') {
        const progressMsg = msg as SDKMessage & {
          tool_name: string;
          elapsed_time_seconds: number;
        };
        logger.toolProgress(progressMsg.tool_name, progressMsg.elapsed_time_seconds);
      }

      // Log subagent/task notifications
      if (msg.type === 'system') {
        const sysMsg = msg as SDKMessage & { subtype?: string; task_id?: string; status?: string; summary?: string };
        if (sysMsg.subtype === 'task_notification') {
          const status = sysMsg.status as 'completed' | 'failed' | 'stopped';
          const statusMap: Record<string, 'complete' | 'failed'> = {
            completed: 'complete',
            failed: 'failed',
            stopped: 'failed',
          };
          logger.subagent(
            `Task ${sysMsg.task_id}`,
            statusMap[status] || 'complete',
            sysMsg.summary
          );
        }
      }

      // Log user messages (tool results)
      if (msg.type === 'user') {
        const userMsg = msg as SDKMessage & { tool_use_result?: unknown };
        if (userMsg.tool_use_result !== undefined) {
          logger.detailed('Tool result:', userMsg.tool_use_result);
        }
      }

      // Log final result with total usage
      if (msg.type === 'result') {
        type ModelUsage = {
          inputTokens: number;
          outputTokens: number;
          cacheReadInputTokens: number;
          contextWindow: number;
          costUSD: number;
        };
        const resultMsg = msg as SDKMessage & {
          total_cost_usd: number;
          modelUsage: Record<string, ModelUsage>;
          num_turns: number;
        };
        logger.result(resultMsg.total_cost_usd, resultMsg.modelUsage, resultMsg.num_turns);
      }

      // Update lock file periodically based on session state
      updateLockFileFromState(options.provider, options.model, lockStatus);
    }

    logger.step('Orchestrator completed successfully');
    lockStatus.phase = 'complete';
    lockStatus.updatedAt = new Date().toISOString();
    writeLockFile(options.provider, options.model, lockStatus);
  } catch (error) {
    logger.error('Orchestrator failed', { error: String(error) });
    throw error;
  } finally {
    deleteLockFile(options.provider, options.model);
  }
}

function setupLogger(provider: string, model: string, runId: string): Logger {
  const runDir = getRunDir(provider, model, runId);
  const logPath = join(runDir, 'logs', 'orchestrator.log');
  mkdirSync(join(runDir, 'logs'), { recursive: true });
  return new Logger(logPath);
}

/**
 * Convert Windows path to Git Bash path format
 * C:\dev\foo -> /c/dev/foo
 */
function toGitBashPath(windowsPath: string): string {
  // Replace backslashes with forward slashes
  let path = windowsPath.replace(/\\/g, '/');
  // Convert C: to /c (case-insensitive drive letter)
  path = path.replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`);
  return path;
}

/**
 * Build the comprehensive orchestrator prompt with all context and instructions
 */
function buildOrchestratorPrompt(
  options: OrchestratorOptions,
  runId: string,
  lockStatus: LockFileStatus
): string {
  // Calculate workspace root (two levels up from src/)
  const workspaceRoot = join(import.meta.dir, '..', '..');
  const tmpDir = getTmpModelDir(options.provider, options.model);
  const runDir = getRunDir(options.provider, options.model, runId);
  // Working guidelines are stored in generated/ so they can be committed to git as they improve
  const workingGuidelinesPath = getWorkingGuidelinesPath(options.provider, options.model);
  const checkpointPath = getCheckpointPath(options.provider, options.model);
  const historyPath = join(tmpDir, 'iteration_history.json');
  const resultsPath = join(runDir, 'results.jsonl');
  const outputDir = join(runDir, 'eval_output');
  const legacyGuidelinesPath = join(workspaceRoot, 'runner', 'models', 'guidelines.py');

  // Convert to Git Bash paths for Bash tool (SDK runs in Git Bash on Windows)
  const bashWorkspaceRoot = toGitBashPath(workspaceRoot);
  const bashWorkingGuidelinesPath = toGitBashPath(workingGuidelinesPath);
  const bashOutputDir = toGitBashPath(outputDir);
  const bashResultsPath = toGitBashPath(resultsPath);

  // Read current state
  const workingGuidelines = readWorkingGuidelines(options.provider, options.model);
  const history = readIterationHistory(options.provider, options.model);
  const recentFeedback = getRecentIterationFeedback(history, 5);

  const historySection =
    recentFeedback.length > 0
      ? formatIterationFeedbackForPrompt(recentFeedback)
      : 'No previous iteration history available.';

  return `You are the orchestrator agent for an automated guideline generation system for Convex code generation.

## Your Mission

Generate and refine guidelines that help AI models generate correct Convex code. You will iterate through a construction phase (building guidelines) and a refinement phase (simplifying guidelines).

## CRITICAL CONTEXT MANAGEMENT RULES

To conserve your context window (you have 200K tokens), follow these rules STRICTLY:

1. **DO NOT read results.jsonl** - Use the GetEvalSummary tool from orchestrator-tools MCP server instead
2. **DO NOT read run.log files** - Use GetRunLogError tool, or pass paths to failure-analyser subagent
3. **DO NOT read generated code or expected answers** - Pass paths to failure-analyser, let it read
4. **DO NOT read working_guidelines.txt** - It's already included in this prompt below
5. **DO NOT search for "legacy guidelines"** - There are none, the path in the prompt is just a placeholder

Use the custom tools (GetEvalSummary, GroupFailuresByPattern, GetFailedEvalDetails, GetRunLogError) for eval operations.
Delegate all file reading to subagents when analyzing failures.

## Current Context

- **Target Model**: ${options.provider}/${options.model}
- **Run ID**: ${runId}
- **Working Directory**: ${tmpDir}
- **Run Directory**: ${runDir}
- **Current Iteration**: ${lockStatus.iteration}
- **Best Pass Count**: ${lockStatus.bestPassCount ?? 0}
- **Stable Iterations**: ${lockStatus.stableIterations ?? 0}

## File Paths

All paths are relative to the workspace root (where you can use Read/Write tools):

- **Working Guidelines**: ${workingGuidelinesPath} (in generated/ so you can commit to git as guidelines improve)
- **Checkpoint Guidelines**: ${checkpointPath} (best-known-good, for regression recovery)
- **Iteration History**: ${historyPath}
- **Eval Results**: ${resultsPath}
- **Eval Output Directory**: ${outputDir}

## Current Working Guidelines

${workingGuidelines || '(No guidelines yet - start with empty guidelines)'}

## Iteration History & Feedback

${historySection}

## Algorithm: Construction Phase

You are in the **Construction Phase**. Follow this algorithm:

### 1. Run Evals

Use Bash to run the eval runner. IMPORTANT: The Bash tool runs in Git Bash on Windows, so use Unix-style paths.

\`\`\`bash
cd ${bashWorkspaceRoot} && MODELS=${options.model} TEST_FILTER=${options.filter || ''} CUSTOM_GUIDELINES_PATH=${bashWorkingGuidelinesPath} OUTPUT_TEMPDIR=${bashOutputDir} LOCAL_RESULTS=${bashResultsPath} DISABLE_BRAINTRUST=1 VERBOSE_INFO_LOGS=1 pdm run python -m runner.eval_convex_coding
\`\`\`

This command will take 20-60 minutes to complete. Just wait for it - do NOT use Task/TaskOutput for this.

After the command completes, use Bash to extract just the summary from results:

\`\`\`bash
tail -1 ${bashResultsPath} | jq '{passed, failed, total, failures: [.results[] | select(.passed == false) | .evalName]}'
\`\`\`

This gives you just the counts and list of failed eval names - NOT the full results which would waste context.

Only if you need details for a specific failure, extract just that one:
\`\`\`bash
tail -1 ${bashResultsPath} | jq '.results[] | select(.evalName == "category/name")'
\`\`\`

### 2. Check for 100% Pass Rate

If \`failed === 0\`:
- Run the evals ${STABILITY_CHECK_RUNS} more times (reliability check)
- If all ${STABILITY_CHECK_RUNS} runs pass:
  - Copy working guidelines to checkpoint: \`${checkpointPath}\`
  - Update lock file phase to "complete"
  - **STOP** - you're done with construction phase (working guidelines are already in generated/ for git commit)
- If any reliability check fails, continue to step 3

### 3. Check for Regression

Read the lock file to get \`bestPassCount\` and \`previousPassCount\`.

If \`passed < bestPassCount - ${MAX_REGRESSION_ALLOWED}\`:
- This is a regression! Revert to checkpoint:
  - Read checkpoint from \`${checkpointPath}\`
  - Write it to working guidelines: \`${workingGuidelinesPath}\`
  - Update lock file: set \`bestPassCount\` back, reset \`stableIterations\` to 0
  - **Go back to step 1** (skip analysis for this iteration)

### 4. Update Best Result and Checkpoint

If \`passed > bestPassCount\`:
- New best! Update lock file:
  - \`bestPassCount = passed\`
  - \`bestIteration = current iteration\`
  - \`stableIterations = 1\`
- Save checkpoint: copy working guidelines to \`${checkpointPath}\`

If \`passed === bestPassCount\`:
- Increment \`stableIterations\` in lock file

If \`passed < bestPassCount\`:
- Reset \`stableIterations = 0\` in lock file

### 5. Check for "Good Enough" Plateau

Calculate: \`passRate = passed / total\`

If \`passRate >= ${MIN_PASS_RATE_THRESHOLD}\` AND \`stableIterations >= ${STABLE_PLATEAU_ITERATIONS}\`:
- We've reached a stable plateau at ${(MIN_PASS_RATE_THRESHOLD * 100).toFixed(0)}%+ for ${STABLE_PLATEAU_ITERATIONS} iterations
- Copy working guidelines to checkpoint: \`${checkpointPath}\`
- Update lock file phase to "complete"
- **STOP** - construction phase complete (working guidelines are already in generated/ for git commit)

### 6. Check Iteration Limit

If \`iteration >= ${MAX_CONSTRUCTION_ITERATIONS}\`:
- Check if current pass rate >= ${(MIN_PASS_RATE_THRESHOLD * 100).toFixed(0)}%
- If yes, accept as good enough and commit
- If no, report failure and stop

### 7. Analyze Failures

**IMPORTANT: To conserve context, do NOT read failure files yourself. Delegate to subagents.**

If there are failures (\`failed > 0\`):
- Group failures by error pattern (e.g., all "v.json() doesn't exist" failures together)
- For each failure pattern, invoke the \`failure-analyser\` subagent using the Task tool
- Pass only FILE PATHS to the subagent - let the subagent read the files
- DO NOT read run.log, generated code, or expected answers yourself - this wastes orchestrator context

Example Task invocation (pass paths, not content):
\`\`\`
Analyze this failed Convex eval:

Eval Name: category/name
Task File: ${bashWorkspaceRoot}/evals/category/name/TASK.txt
Expected Answer: ${bashWorkspaceRoot}/evals/category/name/answer/convex/
Generated Output: ${bashOutputDir}/output/${options.model}/category/name/convex/
Run Log: ${bashOutputDir}/output/${options.model}/category/name/run.log

Read these files, analyze why the generated code failed, and suggest a guideline fix.
\`\`\`

The failure-analyser will read the files itself and return a concise analysis:
\`\`\`
ANALYSIS: [1-2 sentence explanation]
SUGGESTED_GUIDELINE: [guideline text]
CONFIDENCE: [high|medium|low]
\`\`\`

**Batch similar failures**: If 5 evals fail with "v.json() doesn't exist", analyze ONE representative case, not all 5.

### 8. Filter and Group Analyses

- Filter out analyses with \`CONFIDENCE: low\` - ignore those
- Group remaining analyses by category (pagination, imports, storage, queries, mutations, etc.)
- If no high/medium confidence analyses, skip to step 10

### 9. Incorporate Suggestions

Invoke the \`incorporator\` subagent using the Task tool:
- Provide current guidelines
- Provide grouped failure analyses (with eval names)
- Provide iteration history feedback
- Provide legacy guidelines reference

Example Task invocation:
\`\`\`
Use the incorporator agent to synthesize these failure analyses into updated guidelines:

Current Guidelines:
[working guidelines content]

Failure Analyses (grouped):
### Pagination Issues (3 failures)
- eval1: [analysis]
- eval2: [analysis]
...

Iteration History:
[formatted feedback]

Legacy Guidelines:
[if available]
\`\`\`

The incorporator will return updated guidelines text (markdown format).

### 10. Save Updated Guidelines

- Write the incorporator's output to \`${workingGuidelinesPath}\`
- Update iteration history:
  - Read \`${historyPath}\` (JSON format)
  - Append new iteration record with:
    - \`iteration\`: current iteration number
    - \`runId\`: ${runId}
    - \`timestamp\`: ISO timestamp
    - \`passCount\`: current passed count
    - \`failCount\`: current failed count
    - \`evalResults\`: object mapping evalName -> passed (boolean)
    - \`guidelinesDiff\`: summary of changes (e.g., "Added ~50 tokens")
  - Write back to \`${historyPath}\`
- Update lock file:
  - Increment \`iteration\`
  - Update \`lastEvalResult\` with current results
  - Update \`currentAction\`
  - Update \`updatedAt\`

### 11. Loop

Go back to step 1 and run evals again with updated guidelines.

## Algorithm: Refinement Phase

After construction phase completes (100% pass or good-enough plateau), enter **Refinement Phase**:

1. Read current guidelines from \`${workingGuidelinesPath}\`
2. Propose ONE refinement:
   - Remove a guideline you suspect is unnecessary
   - Combine overlapping guidelines
   - Simplify wording while preserving meaning
3. Write proposal to \`${join(runDir, 'proposal_001.txt')}\` (increment number for each proposal)
4. Test proposal ${STABILITY_CHECK_RUNS} times:
   - Run evals with proposal as guidelines
   - If all ${STABILITY_CHECK_RUNS} runs pass, commit the proposal
   - If any fail, try a different refinement
5. Stop after 10 consecutive failed refinement attempts

## Lock File Format

The lock file is at \`${join(tmpDir, '.lock')}\`. It's JSON with:
- \`runId\`: ${runId}
- \`pid\`: process ID
- \`startedAt\`: ISO timestamp
- \`phase\`: "construction" | "refinement" | "complete"
- \`iteration\`: current iteration number
- \`lastEvalResult\`: { passed, failed, total }
- \`currentAction\`: string describing current step
- \`updatedAt\`: ISO timestamp
- \`bestPassCount\`: best passing count achieved
- \`bestIteration\`: iteration where best was achieved
- \`stableIterations\`: consecutive iterations at same pass count

Read and update this file to track progress.

## Important Notes

- Always update the lock file after significant state changes
- Use Read/Write tools for all file operations
- Use Bash tool to run the eval runner - it will block until completion (can take 20-60 minutes)
- Do NOT use Task/TaskOutput to run evals in the background - just use Bash directly and wait
- Use Task tool ONLY to invoke subagents (failure-analyser, incorporator)
- Guidelines must use markdown headers (##) and bullet points (-), NOT numbered lists
- Keep iteration history limited to last 20 iterations
- Be methodical and follow the algorithm step by step

## CRITICAL: Context Management

You have 200K tokens of context. Conserve it aggressively by using the custom tools below.

## Custom Tools (Use These!)

You have access to these specialized tools via the \`orchestrator-tools\` MCP server. **PREFER these over raw Bash/Read for eval operations:**

### GetEvalSummary
Returns just the pass/fail counts and list of failed eval names. Use this instead of reading results.jsonl directly.
- Returns: \`{passed, failed, total, failures: [evalName, ...]}\`

### GroupFailuresByPattern
Analyzes all failures and groups them by error pattern. Returns representative eval for each pattern.
- Returns: \`[{pattern, count, representative, allEvals, sampleError}, ...]\`
- Use this to identify which failure patterns to analyze (pick 1 representative per pattern)

### GetFailedEvalDetails
Get paths for a specific failed eval to pass to failure-analyser subagent.
- Input: \`{evalName: "002-queries/009-text_search"}\`
- Returns: paths to task, expected answer, generated output, run log

### GetRunLogError
Extract just the error lines from a run.log (not the full log).
- Input: \`{evalName: "002-queries/009-text_search"}\`
- Returns: grep'd error lines (max 20 lines)

### SaveCheckpoint / RevertToCheckpoint
Manage checkpoints without reading/writing files manually.

### GetLegacyGuidelines
Get reference guidelines from the original Convex eval system. Use this when analyzing failures to see if there's existing guidance on a topic.
- Input: \`{section: "pagination"}\` (optional filter) 
- Returns: Array of \`{section, guideline}\` objects
- Example sections: "function_guidelines", "pagination", "cron_guidelines", "file_storage_guidelines", "schema_guidelines"

## Recommended Workflow (FOLLOW THIS EXACTLY)

1. Run evals with Bash (wait 20-60 min for completion)
2. **USE GetEvalSummary** (not Python/jq) to get pass/fail counts
3. If failures exist, **USE GroupFailuresByPattern** to cluster by error type  
4. For each pattern, **USE GetFailedEvalDetails** to get file paths
5. Invoke failure-analyser Task with the paths (let subagent read files)
6. Collect all suggested guidelines from subagents
7. Invoke incorporator Task with current guidelines + suggestions
8. Write updated guidelines and repeat from step 1

**DO NOT**: Use Python scripts, jq, or read files directly for eval results

## Your Task

Begin the construction phase. Start by running evals with the current working guidelines, then follow the algorithm above.

Remember: You are an autonomous agent. Make decisions, update files, invoke subagents, and iterate until you complete the construction phase (and optionally refinement phase).`;
}

/**
 * Helper to update lock file based on current state
 */
function updateLockFileFromState(
  provider: string,
  model: string,
  lockStatus: LockFileStatus
): void {
  // Read current files to infer state
  const history = readIterationHistory(provider, model);
  if (history.iterations.length > 0) {
    const last = history.iterations[history.iterations.length - 1];
    lockStatus.iteration = last.iteration;
    lockStatus.lastEvalResult = {
      passed: last.passCount,
      failed: last.failCount,
      total: last.passCount + last.failCount,
    };
  }
  lockStatus.updatedAt = new Date().toISOString();
  writeLockFile(provider, model, lockStatus);
}

/**
 * Format iteration feedback for the orchestrator prompt
 */
function formatIterationFeedbackForPrompt(feedback: IterationFeedback[]): string {
  if (feedback.length === 0) {
    return 'No previous iteration history available.';
  }

  return feedback
    .map((f) => {
      const direction = f.passCountDelta > 0 ? '+' : '';
      const status =
        f.passCountDelta > 0 ? 'improvement' : f.passCountDelta < 0 ? 'regression' : 'no change';

      let result = `### Iteration ${f.previousIteration} → ${f.currentIteration}: ${direction}${f.passCountDelta} passing (${status})\n`;
      result += `- Changes made: ${f.changesMade}\n`;

      if (f.evalsFlippedToPass.length > 0) {
        result += `- Evals that started passing: ${f.evalsFlippedToPass.slice(0, 5).join(', ')}`;
        if (f.evalsFlippedToPass.length > 5) {
          result += ` (and ${f.evalsFlippedToPass.length - 5} more)`;
        }
        result += '\n';
      }

      if (f.evalsFlippedToFail.length > 0) {
        result += `- Evals that regressed: ${f.evalsFlippedToFail.slice(0, 5).join(', ')}`;
        if (f.evalsFlippedToFail.length > 5) {
          result += ` (and ${f.evalsFlippedToFail.length - 5} more)`;
        }
        result += '\n';
      }

      return result;
    })
    .join('\n');
}
