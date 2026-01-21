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

    // Create query with subagents using V1 API
    logger.step('Starting orchestrator agent query');

    const q = query({
      prompt,
      options: {
        model: 'claude-opus-4-5',
        allowedTools: ['Read', 'Write', 'Bash', 'Glob', 'Grep', 'Task'],
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
  const workingGuidelinesPath = getWorkingGuidelinesPath(options.provider, options.model);
  const checkpointPath = getCheckpointPath(options.provider, options.model);
  const committedPath = getCommittedGuidelinesPath(options.provider, options.model);
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

- **Working Guidelines**: ${workingGuidelinesPath}
- **Checkpoint Guidelines**: ${checkpointPath}
- **Committed Guidelines**: ${committedPath}
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

After the command completes, read the results from \`${resultsPath}\` (use Windows path for Read tool). The file is JSONL format - read the LAST line (most recent run).

Parse the results to get:
- \`passed\`: number of passing evals
- \`failed\`: number of failing evals
- \`total\`: total evals
- \`results\`: array of individual eval results

Each eval result has:
- \`evalName\`: name like "category/name"
- \`passed\`: boolean
- \`taskPath\`: path to TASK.txt
- \`expectedFiles\`: array of expected file paths
- \`outputFiles\`: array of actual output file paths
- \`runLogPath\`: path to run.log

### 2. Check for 100% Pass Rate

If \`failed === 0\`:
- Run the evals ${STABILITY_CHECK_RUNS} more times (reliability check)
- If all ${STABILITY_CHECK_RUNS} runs pass:
  - Copy working guidelines to committed location: \`${committedPath}\`
  - Copy to checkpoint: \`${checkpointPath}\`
  - Update lock file phase to "complete"
  - **STOP** - you're done with construction phase
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
- Copy working guidelines to committed: \`${committedPath}\`
- Update lock file phase to "complete"
- **STOP** - construction phase complete

### 6. Check Iteration Limit

If \`iteration >= ${MAX_CONSTRUCTION_ITERATIONS}\`:
- Check if current pass rate >= ${(MIN_PASS_RATE_THRESHOLD * 100).toFixed(0)}%
- If yes, accept as good enough and commit
- If no, report failure and stop

### 7. Analyze Failures

If there are failures (\`failed > 0\`):
- For each failed eval, invoke the \`failure-analyser\` subagent using the Task tool
- Provide the eval context:
  - Read \`taskPath\` (TASK.txt)
  - Read expected files from \`expectedFiles\`
  - Read output files from \`outputFiles\`
  - Read \`runLogPath\` (run.log)
  - Optionally read legacy guidelines from \`${legacyGuidelinesPath}\` if it exists

Example Task invocation:
\`\`\`
Use the failure-analyser agent to analyze this failed eval:

Eval: category/name
Task: [content of TASK.txt]
Expected: [content of expected files]
Actual: [content of output files]
Run Log: [content of run.log]
Legacy Guidelines: [if available]
\`\`\`

The failure-analyser will return analysis in this format:
\`\`\`
ANALYSIS: [explanation]
SUGGESTED_GUIDELINE: [guideline text]
CONFIDENCE: [high|medium|low]
RELATED_LEGACY: [related snippets or None]
\`\`\`

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

1. Read committed guidelines from \`${committedPath}\`
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
- Use Bash tool to run the eval runner - it will block until completion (can take 5-10 minutes)
- Do NOT use Task/TaskOutput to run evals in the background - just use Bash directly and wait
- Use Task tool ONLY to invoke subagents (failure-analyser, incorporator)
- The eval runner writes results to JSONL - always read the LAST line
- Guidelines must use markdown headers (##) and bullet points (-), NOT numbered lists
- Keep iteration history limited to last 20 iterations
- Be methodical and follow the algorithm step by step
- CONTEXT MANAGEMENT: Be mindful of context usage. Avoid reading large files unnecessarily. When reading results, only read the specific file paths needed (like results.jsonl), not intermediate output files.

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
