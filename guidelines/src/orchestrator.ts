import { anthropic } from '@ai-sdk/anthropic';
import { generateText } from 'ai';
import { randomBytes } from 'crypto';
import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';

// Use Claude Opus for orchestration tasks
const MODEL_ID = 'claude-opus-4-5';

// Safety limit to prevent infinite loops in construction phase
const MAX_CONSTRUCTION_ITERATIONS = 50;

/**
 * Generate a human-readable, sortable run ID.
 * Format: YYYY-MM-DD_HH-mm-ss_xxxx (sorts alphabetically by date)
 */
function generateRunId(): string {
  const now = new Date();
  const date = now.toISOString().slice(0, 10); // YYYY-MM-DD
  const time = now.toTimeString().slice(0, 8).replace(/:/g, '-'); // HH-mm-ss
  const random = randomBytes(2).toString('hex'); // 4 char hex
  return `${date}_${time}_${random}`;
}
import type { LockFileStatus, FailureAnalysis } from './types.js';
import { Logger } from './logger.js';
import {
  readGuidelines,
  writeGuidelines,
  readWorkingGuidelines,
  writeWorkingGuidelines,
  writeProposal,
  getRunDir,
  countTokens,
} from './guidelineStore.js';
import { readLockFile, writeLockFile, deleteLockFile, isProcessRunning } from './lockFile.js';
import { runEvals } from './evalRunner.js';
import { analyzeFailure } from './failureAnalyser.js';

export interface OrchestratorOptions {
  model: string;
  provider: string;
  filter?: string;
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
  };
  writeLockFile(options.provider, options.model, lockStatus);

  try {
    // Create run directory
    const runDir = getRunDir(options.provider, options.model, runId);
    mkdirSync(join(runDir, 'logs'), { recursive: true });

    // Copy committed guidelines to working guidelines
    const committedGuidelines = readGuidelines(options.provider, options.model);
    writeWorkingGuidelines(options.provider, options.model, runId, committedGuidelines);

    logger.info(`Starting with ${committedGuidelines ? 'existing' : 'empty'} guidelines`);

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

async function constructionPhase(
  options: OrchestratorOptions,
  runId: string,
  logger: Logger
): Promise<void> {
  logger.step('Entering Construction Phase');

  const lockStatus = readLockFile(options.provider, options.model)!;
  lockStatus.phase = 'construction';
  lockStatus.iteration = 0;
  lockStatus.updatedAt = new Date().toISOString();
  writeLockFile(options.provider, options.model, lockStatus);

  let iteration = 0;

  while (iteration < MAX_CONSTRUCTION_ITERATIONS) {
    iteration++;
    logger.step(`Construction iteration ${iteration}/${MAX_CONSTRUCTION_ITERATIONS}`);

    lockStatus.iteration = iteration;
    lockStatus.currentAction = 'running evals';
    lockStatus.updatedAt = new Date().toISOString();
    writeLockFile(options.provider, options.model, lockStatus);

    // Run evals with working guidelines
    const workingGuidelinesPath = join(
      getRunDir(options.provider, options.model, runId),
      'working_guidelines.txt'
    );

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
    lockStatus.updatedAt = new Date().toISOString();
    writeLockFile(options.provider, options.model, lockStatus);

    if (result.failed === 0) {
      logger.step('All evals passed! Running reliability check (3x)...');
      const allPass = await reliabilityCheck(options, runId, logger, workingGuidelinesPath);

      if (allPass) {
        logger.step('Reliability check passed! Copying to committed location.');
        const workingGuidelines = readWorkingGuidelines(options.provider, options.model, runId);
        writeGuidelines(options.provider, options.model, workingGuidelines);
        return;
      }

      logger.info('Reliability check failed, continuing construction');
    }

    // Analyze failures
    logger.step(`Analyzing ${result.failed} failures`);
    lockStatus.currentAction = 'analyzing failures';
    lockStatus.updatedAt = new Date().toISOString();
    writeLockFile(options.provider, options.model, lockStatus);

    const evalResult = result.results.filter(r => !r.passed);
    const legacyGuidelines = await getLegacyGuidelines();
    const analyses = await Promise.all(
      evalResult.map(evalItem => analyzeFailure(evalItem, legacyGuidelines))
    );

    // Incorporate suggestions
    logger.step('Incorporating guideline suggestions');
    lockStatus.currentAction = 'incorporating suggestions';
    lockStatus.updatedAt = new Date().toISOString();
    writeLockFile(options.provider, options.model, lockStatus);

    const currentGuidelines = readWorkingGuidelines(options.provider, options.model, runId);
    const updatedGuidelines = await incorporateSuggestions(currentGuidelines, analyses, logger);

    writeWorkingGuidelines(options.provider, options.model, runId, updatedGuidelines);

    logger.info(`Updated guidelines (${countTokens(updatedGuidelines)} tokens)`);
  }

  throw new Error(
    `Construction phase failed after ${MAX_CONSTRUCTION_ITERATIONS} iterations. ` +
      `Last result: ${lockStatus.lastEvalResult?.passed}/${lockStatus.lastEvalResult?.total} passing`
  );
}

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
      failedProposalSummaries.length = 0; // Reset on success
    } else {
      logger.info(`Proposal ${proposalNum} failed. Keeping for debugging.`);
      failedAttempts++;
      // Track what was tried so we don't repeat it
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

  // Simple heuristic summary - could be more sophisticated
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

async function incorporateSuggestions(
  currentGuidelines: string,
  analyses: FailureAnalysis[],
  logger: Logger
): Promise<string> {
  const formatAnalysis = (a: FailureAnalysis, i: number) =>
    `### Suggestion ${i + 1} (confidence: ${a.confidence})
**Analysis:** ${a.analysis}
**Suggested Guideline:** ${a.suggestedGuideline}
${a.relatedLegacyGuidelines.length > 0 ? `**Related Legacy Guidelines:** ${a.relatedLegacyGuidelines.join('; ')}` : ''}`;

  const prompt = `You are an expert at creating concise, effective guidelines for AI code generation.

## Current Guidelines
${currentGuidelines || 'None yet'}

## New Suggestions from Failure Analysis
${analyses.map(formatAnalysis).join('\n\n')}

## Your Task

Review the suggestions and current guidelines. Create an updated version that:
- Prioritize HIGH confidence suggestions over medium/low
- Deduplicates similar guidelines
- Resolves any conflicts
- Keeps each guideline focused on one concept
- Orders guidelines from most to least commonly needed
- Minimizes token count while preserving effectiveness
- Uses specific examples where helpful
- Each guideline should be 50-100 tokens
- Consider the related legacy guidelines when crafting new ones

Return ONLY the updated guidelines text, no commentary.`;

  const result = await generateText({
    model: anthropic(MODEL_ID),
    prompt,
    temperature: 0.7,
  });

  return result.text;
}

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

Return ONLY the refined guidelines text, no commentary.`;

  const result = await generateText({
    model: anthropic(MODEL_ID),
    prompt,
    temperature: 0.7,
  });

  return result.text;
}

async function getLegacyGuidelines(): Promise<string> {
  const path = join(import.meta.dir, '..', '..', 'runner', 'models', 'guidelines.py');
  if (!existsSync(path)) return '';

  const { readFileSync } = await import('fs');
  return readFileSync(path, 'utf-8');
}
