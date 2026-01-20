import { anthropic } from '@ai-sdk/anthropic';
import { generateText } from 'ai';
import { randomBytes } from 'crypto';
import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';

import type { LockFileStatus, FailureAnalysis, EvalStability, IterationRecord } from './types.js';
import { Logger } from './logger.js';
import {
  readGuidelines,
  writeGuidelines,
  readWorkingGuidelines,
  writeWorkingGuidelines,
  writeProposal,
  getRunDir,
  countTokens,
  getWorkingGuidelinesPath,
  readCheckpoint,
  writeCheckpoint,
} from './guidelineStore.js';
import { readLockFile, writeLockFile, deleteLockFile, isProcessRunning } from './lockFile.js';
import { runEvals } from './evalRunner.js';
import { analyzeFailure } from './failureAnalyser.js';
import { runIncorporator } from './incorporator.js';
import {
  readIterationHistory,
  appendIterationRecord,
  summarizeGuidelinesDiff,
  updateLastIterationDiff,
} from './iterationHistory.js';

// Use Claude Opus for orchestration tasks
const MODEL_ID = 'claude-opus-4-5';

// ============================================================================
// Configuration Constants
// ============================================================================

// Safety limit to prevent infinite loops in construction phase
const MAX_CONSTRUCTION_ITERATIONS = 50;

// Max parallel failure analyzers to prevent rate limiting
const MAX_PARALLEL_ANALYZERS = 5;

// "Good enough" threshold - if we can't achieve 100%, accept this pass rate
const MIN_PASS_RATE_THRESHOLD = 0.90; // 90%

// Number of iterations at plateau before accepting as "good enough"
const STABLE_PLATEAU_ITERATIONS = 5;

// Maximum regression allowed before reverting to checkpoint
const MAX_REGRESSION_ALLOWED = 2; // If we drop more than 2 passing evals, revert

// Number of runs to determine eval stability (flaky detection)
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
  // Use UTC consistently for proper alphabetical sorting
  const iso = now.toISOString();
  const date = iso.slice(0, 10); // YYYY-MM-DD
  const time = iso.slice(11, 19).replace(/:/g, '-'); // HH-mm-ss (from HH:mm:ss)
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

    // Initialize working guidelines from committed (if exists) or checkpoint (if exists)
    const committedGuidelines = readGuidelines(options.provider, options.model);
    const checkpointGuidelines = readCheckpoint(options.provider, options.model);
    const existingWorking = readWorkingGuidelines(options.provider, options.model);

    // Priority: existing working > checkpoint > committed > empty
    const startingGuidelines = existingWorking || checkpointGuidelines || committedGuidelines;
    
    if (!existingWorking) {
      writeWorkingGuidelines(options.provider, options.model, startingGuidelines);
    }

    const source = existingWorking ? 'existing working' : 
                   checkpointGuidelines ? 'checkpoint' : 
                   committedGuidelines ? 'committed' : 'empty';
    logger.info(`Starting with ${source} guidelines (${countTokens(startingGuidelines)} tokens)`);

    // Begin construction phase
    await constructionPhase(options, runId, logger);

    // Begin refinement phase
    await refinementPhase(options, runId, logger);

    logger.step('Orchestrator completed successfully');
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

// ============================================================================
// Construction Phase
// ============================================================================

async function constructionPhase(
  options: OrchestratorOptions,
  runId: string,
  logger: Logger
): Promise<void> {
  logger.step('Entering Construction Phase');

  const lockStatus = readLockFile(options.provider, options.model)!;
  lockStatus.phase = 'construction';
  lockStatus.iteration = 0;
  lockStatus.bestPassCount = 0;
  lockStatus.bestIteration = 0;
  lockStatus.stableIterations = 0;
  lockStatus.updatedAt = new Date().toISOString();
  writeLockFile(options.provider, options.model, lockStatus);

  let iteration = 0;
  let previousPassCount = 0;

  while (iteration < MAX_CONSTRUCTION_ITERATIONS) {
    iteration++;
    logger.step(`Construction iteration ${iteration}/${MAX_CONSTRUCTION_ITERATIONS}`);

    lockStatus.iteration = iteration;
    lockStatus.currentAction = 'running evals';
    lockStatus.updatedAt = new Date().toISOString();
    writeLockFile(options.provider, options.model, lockStatus);

    // Run evals with working guidelines (at model level, not run level)
    const workingGuidelinesPath = getWorkingGuidelinesPath(options.provider, options.model);

    const result = await runEvals({
      model: options.model,
      provider: options.provider,
      runId,
      filter: options.filter,
      guidelinesPath: workingGuidelinesPath,
    });

    logger.info('Eval results', {
      passed: result.passed,
      failed: result.failed,
      total: result.total,
    });

    lockStatus.lastEvalResult = {
      passed: result.passed,
      failed: result.failed,
      total: result.total,
    };

    // Save iteration record for history tracking
    const evalResults: Record<string, boolean> = {};
    for (const evalResult of result.results) {
      evalResults[evalResult.evalName] = evalResult.passed;
    }

    const iterationRecord: IterationRecord = {
      iteration,
      runId,
      timestamp: new Date().toISOString(),
      passCount: result.passed,
      failCount: result.failed,
      evalResults,
    };
    appendIterationRecord(options.provider, options.model, iterationRecord);

    // ========================================================================
    // Check for 100% pass rate
    // ========================================================================
    if (result.failed === 0) {
      logger.step('All evals passed! Running reliability check (3x)...');
      const allPass = await reliabilityCheck(options, runId, logger, workingGuidelinesPath);

      if (allPass) {
        logger.step('Reliability check passed! Copying to committed location.');
        const workingGuidelines = readWorkingGuidelines(options.provider, options.model);
        writeGuidelines(options.provider, options.model, workingGuidelines);
        writeCheckpoint(options.provider, options.model, workingGuidelines);
        return;
      }

      logger.info('Reliability check failed, continuing construction');
    }

    // ========================================================================
    // Check for regression - revert to checkpoint if we dropped too much
    // ========================================================================
    if (result.passed < previousPassCount - MAX_REGRESSION_ALLOWED) {
      const checkpoint = readCheckpoint(options.provider, options.model);
      if (checkpoint) {
        logger.warn(`Regression detected! Dropped from ${previousPassCount} to ${result.passed}. Reverting to checkpoint.`);
        writeWorkingGuidelines(options.provider, options.model, checkpoint);
        previousPassCount = lockStatus.bestPassCount ?? 0;
        continue; // Skip this iteration's analysis, retry with checkpoint
      }
    }

    // ========================================================================
    // Track best result and update checkpoint
    // ========================================================================
    const bestPassCount = lockStatus.bestPassCount ?? 0;
    if (result.passed > bestPassCount) {
      logger.info(`New best: ${result.passed} passing (previous: ${bestPassCount})`);
      lockStatus.bestPassCount = result.passed;
      lockStatus.bestIteration = iteration;
      lockStatus.stableIterations = 1;
      
      // Save checkpoint
      const currentGuidelines = readWorkingGuidelines(options.provider, options.model);
      writeCheckpoint(options.provider, options.model, currentGuidelines);
    } else if (result.passed === bestPassCount) {
      lockStatus.stableIterations = (lockStatus.stableIterations ?? 0) + 1;
    } else {
      lockStatus.stableIterations = 0;
    }

    lockStatus.updatedAt = new Date().toISOString();
    writeLockFile(options.provider, options.model, lockStatus);

    // ========================================================================
    // Check for "good enough" plateau
    // ========================================================================
    const passRate = result.passed / result.total;
    const stableIterations = lockStatus.stableIterations ?? 0;

    if (passRate >= MIN_PASS_RATE_THRESHOLD && stableIterations >= STABLE_PLATEAU_ITERATIONS) {
      logger.step(
        `Reached stable plateau at ${(passRate * 100).toFixed(1)}% ` +
        `(${result.passed}/${result.total}) for ${stableIterations} iterations. ` +
        `Accepting as good enough.`
      );
      const workingGuidelines = readWorkingGuidelines(options.provider, options.model);
      writeGuidelines(options.provider, options.model, workingGuidelines);
      return;
    }

    previousPassCount = result.passed;

    // ========================================================================
    // Identify consistently failing evals (ignore flaky ones for now)
    // ========================================================================
    const failedEvals = result.results.filter(r => !r.passed);
    
    // Only analyze if we have failures
    if (failedEvals.length === 0) continue;

    logger.step(`Analyzing ${failedEvals.length} failures (max ${MAX_PARALLEL_ANALYZERS} parallel)`);
    lockStatus.currentAction = `analyzing ${failedEvals.length} failures`;
    lockStatus.updatedAt = new Date().toISOString();
    writeLockFile(options.provider, options.model, lockStatus);

    const legacyGuidelines = await getLegacyGuidelines();
    const analyses = await runWithConcurrencyLimit(
      failedEvals,
      (evalItem) => analyzeFailure(evalItem, legacyGuidelines),
      MAX_PARALLEL_ANALYZERS,
      (evalItem, index) => {
        logger.info(`Analyzing failure ${index + 1}/${failedEvals.length}: ${evalItem.evalName}`);
      }
    );

    // Filter to high/medium confidence only
    const goodAnalyses = analyses.filter(a => a.confidence !== 'low');
    if (goodAnalyses.length === 0) {
      logger.info('No high/medium confidence suggestions, skipping incorporation');
      continue;
    }

    // Incorporate suggestions using the incorporator sub-agent
    logger.step(`Incorporating ${goodAnalyses.length} guideline suggestions (filtered from ${analyses.length})`);
    lockStatus.currentAction = 'incorporating suggestions';
    lockStatus.updatedAt = new Date().toISOString();
    writeLockFile(options.provider, options.model, lockStatus);

    const currentGuidelines = readWorkingGuidelines(options.provider, options.model);
    const history = readIterationHistory(options.provider, options.model);

    // Prepare analyses with eval names for grouping
    const analysesWithEvalNames = failedEvals
      .map((evalItem, idx) => ({
        evalName: evalItem.evalName,
        analysis: analyses[idx],
      }))
      .filter((item) => item.analysis.confidence !== 'low');

    const updatedGuidelines = await runIncorporator(
      currentGuidelines,
      analysesWithEvalNames,
      history,
      logger
    );

    // Update the iteration record with the diff summary
    const diffSummary = summarizeGuidelinesDiff(currentGuidelines, updatedGuidelines);
    updateLastIterationDiff(options.provider, options.model, diffSummary);

    writeWorkingGuidelines(options.provider, options.model, updatedGuidelines);

    logger.info(`Updated guidelines (${countTokens(updatedGuidelines)} tokens)`);
    logger.info(`Guidelines diff: ${diffSummary}`);
  }

  // ========================================================================
  // Max iterations reached - check if we should accept current state
  // ========================================================================
  const finalResult = lockStatus.lastEvalResult;
  if (finalResult) {
    const passRate = finalResult.passed / finalResult.total;
    
    if (passRate >= MIN_PASS_RATE_THRESHOLD) {
      logger.step(
        `Max iterations reached. Accepting ${(passRate * 100).toFixed(1)}% pass rate ` +
        `(${finalResult.passed}/${finalResult.total}) as good enough.`
      );
      const workingGuidelines = readWorkingGuidelines(options.provider, options.model);
      writeGuidelines(options.provider, options.model, workingGuidelines);
      return;
    }
  }

  throw new Error(
    `Construction phase failed after ${MAX_CONSTRUCTION_ITERATIONS} iterations. ` +
    `Best result: ${lockStatus.bestPassCount}/${lockStatus.lastEvalResult?.total ?? '?'} passing ` +
    `(${((lockStatus.bestPassCount ?? 0) / (lockStatus.lastEvalResult?.total ?? 1) * 100).toFixed(1)}%). ` +
    `Required: ${(MIN_PASS_RATE_THRESHOLD * 100).toFixed(0)}%`
  );
}

// ============================================================================
// Reliability Check
// ============================================================================

async function reliabilityCheck(
  options: OrchestratorOptions,
  runId: string,
  logger: Logger,
  guidelinesPath: string
): Promise<boolean> {
  for (let i = 1; i <= 2; i++) {
    logger.info(`Reliability check run ${i + 1}/3`);

    const result = await runEvals({
      model: options.model,
      provider: options.provider,
      runId,
      filter: options.filter,
      guidelinesPath,
    });

    if (result.failed > 0) {
      logger.info(`Reliability check failed: ${result.failed} failures`);
      return false;
    }
  }

  return true;
}

// ============================================================================
// Refinement Phase
// ============================================================================

async function refinementPhase(
  options: OrchestratorOptions,
  runId: string,
  logger: Logger
): Promise<void> {
  logger.step('Entering Refinement Phase');

  const lockStatus = readLockFile(options.provider, options.model)!;
  lockStatus.phase = 'refinement';
  lockStatus.iteration = 0;
  lockStatus.updatedAt = new Date().toISOString();
  writeLockFile(options.provider, options.model, lockStatus);

  let proposalNum = 0;
  let failedAttempts = 0;
  const failedProposalSummaries: string[] = [];

  while (failedAttempts < 10) {
    proposalNum++;
    logger.step(`Refinement proposal ${proposalNum} (failed attempts: ${failedAttempts}/10)`);

    lockStatus.iteration = proposalNum;
    lockStatus.currentAction = `proposing refinement ${proposalNum}`;
    lockStatus.updatedAt = new Date().toISOString();
    writeLockFile(options.provider, options.model, lockStatus);

    // Generate refinement proposal with context about what already failed
    const currentGuidelines = readGuidelines(options.provider, options.model);
    const proposal = await generateRefinementProposal(
      currentGuidelines,
      failedProposalSummaries,
      logger
    );

    writeProposal(options.provider, options.model, runId, proposalNum, proposal);
    logger.info(`Proposal ${proposalNum}: ${countTokens(proposal)} tokens`);

    // Test proposal 3x
    lockStatus.currentAction = `testing proposal ${proposalNum}`;
    lockStatus.updatedAt = new Date().toISOString();
    writeLockFile(options.provider, options.model, lockStatus);

    const proposalPath = join(
      getRunDir(options.provider, options.model, runId),
      `proposal_${String(proposalNum).padStart(3, '0')}.txt`
    );

    const allPass = await testProposal(options, runId, logger, proposalPath);

    if (allPass) {
      logger.step(`Proposal ${proposalNum} passed! Committing.`);
      writeGuidelines(options.provider, options.model, proposal);
      failedAttempts = 0;
      failedProposalSummaries.length = 0;
    } else {
      logger.info(`Proposal ${proposalNum} failed. Keeping for debugging.`);
      failedAttempts++;
      const summary = summarizeProposalDiff(currentGuidelines, proposal);
      failedProposalSummaries.push(summary);
    }
  }

  logger.step('Refinement phase complete (10 consecutive failures)');
  lockStatus.phase = 'complete';
  lockStatus.updatedAt = new Date().toISOString();
  writeLockFile(options.provider, options.model, lockStatus);
}

function summarizeProposalDiff(original: string, proposal: string): string {
  const originalTokens = countTokens(original);
  const proposalTokens = countTokens(proposal);
  const diff = originalTokens - proposalTokens;

  if (diff > 50) return `Removed ~${diff} tokens (too aggressive)`;
  if (diff < 0) return `Added ${-diff} tokens (made it longer)`;
  return `Changed ~${Math.abs(diff)} tokens (subtle change that broke evals)`;
}

async function testProposal(
  options: OrchestratorOptions,
  runId: string,
  logger: Logger,
  proposalPath: string
): Promise<boolean> {
  for (let i = 1; i <= 3; i++) {
    logger.info(`Testing proposal run ${i}/3`);

    const result = await runEvals({
      model: options.model,
      provider: options.provider,
      runId,
      filter: options.filter,
      guidelinesPath: proposalPath,
    });

    if (result.failed > 0) {
      logger.info(`Proposal test failed: ${result.failed} failures`);
      return false;
    }
  }

  return true;
}

// ============================================================================
// Refinement Phase
// ============================================================================

async function generateRefinementProposal(
  currentGuidelines: string,
  failedAttempts: string[],
  logger: Logger
): Promise<string> {
  const failedAttemptsSection =
    failedAttempts.length > 0
      ? `
## Previous Failed Refinement Attempts
These refinements were tried but caused eval failures - avoid similar changes:
${failedAttempts.map((f, i) => `${i + 1}. ${f}`).join('\n')}
`
      : '';

  const prompt = `You are an expert at refining guidelines for AI code generation.

## Current Guidelines
${currentGuidelines}
${failedAttemptsSection}
## Your Task

Propose ONE refinement to make these guidelines more concise while maintaining effectiveness:
- Remove a guideline you suspect is unnecessary
- Combine overlapping guidelines
- Simplify wording while preserving meaning

Be conservative - only make changes you're confident won't break the evals.
${failedAttempts.length > 0 ? 'IMPORTANT: Avoid refinements similar to the failed attempts listed above.' : ''}

IMPORTANT FORMATTING RULES:
- Do NOT number the guidelines (no "1.", "2.", etc.)
- Keep the same organizational structure (headers for topics)
- Use bullet points (-) for individual guidelines

Return ONLY the refined guidelines text, no commentary.`;

  const result = await generateText({
    model: anthropic(MODEL_ID),
    prompt,
    temperature: 0.7,
  });

  return result.text;
}

// ============================================================================
// Utility Functions
// ============================================================================

async function getLegacyGuidelines(): Promise<string> {
  const path = join(import.meta.dir, '..', '..', 'runner', 'models', 'guidelines.py');
  if (!existsSync(path)) return '';

  const { readFileSync } = await import('fs');
  return readFileSync(path, 'utf-8');
}

/**
 * Run async tasks with a concurrency limit to prevent rate limiting.
 */
async function runWithConcurrencyLimit<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  maxConcurrency: number,
  onStart?: (item: T, index: number) => void
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let currentIndex = 0;

  async function worker(): Promise<void> {
    while (currentIndex < items.length) {
      const index = currentIndex++;
      const item = items[index];
      onStart?.(item, index);
      results[index] = await fn(item);
    }
  }

  const workers = Array(Math.min(maxConcurrency, items.length))
    .fill(null)
    .map(() => worker());

  await Promise.all(workers);
  return results;
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + '...';
}