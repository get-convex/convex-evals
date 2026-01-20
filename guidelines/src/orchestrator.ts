import { anthropic } from '@ai-sdk/anthropic';
import { generateText, LanguageModel } from 'ai';
import { randomUUID } from 'crypto';
import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';

// Use Claude Opus for orchestration tasks
const MODEL_ID = 'claude-opus-4-5';
import type { LockFileStatus } from './types.js';
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
  const runId = randomUUID();
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

  while (true) {
    iteration++;
    logger.step(`Construction iteration ${iteration}`);

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
    const updatedGuidelines = await incorporateSuggestions(
      currentGuidelines,
      analyses.map(a => a.suggestedGuideline),
      logger
    );

    writeWorkingGuidelines(options.provider, options.model, runId, updatedGuidelines);

    logger.info(`Updated guidelines (${countTokens(updatedGuidelines)} tokens)`);
  }
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

  while (failedAttempts < 10) {
    proposalNum++;
    logger.step(`Refinement proposal ${proposalNum} (failed attempts: ${failedAttempts}/10)`);

    lockStatus.iteration = proposalNum;
    lockStatus.currentAction = `proposing refinement ${proposalNum}`;
    lockStatus.updatedAt = new Date().toISOString();
    writeLockFile(options.provider, options.model, lockStatus);

    // Generate refinement proposal
    const currentGuidelines = readGuidelines(options.provider, options.model);
    const proposal = await generateRefinementProposal(currentGuidelines, logger);

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
    } else {
      logger.info(`Proposal ${proposalNum} failed. Keeping for debugging.`);
      failedAttempts++;
    }
  }

  logger.step('Refinement phase complete (10 consecutive failures)');
  lockStatus.phase = 'complete';
  lockStatus.updatedAt = new Date().toISOString();
  writeLockFile(options.provider, options.model, lockStatus);
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
  suggestions: string[],
  logger: Logger
): Promise<string> {
  const prompt = `You are an expert at creating concise, effective guidelines for AI code generation.

## Current Guidelines
${currentGuidelines || 'None yet'}

## New Suggestions
${suggestions.map((s, i) => `${i + 1}. ${s}`).join('\n')}

## Your Task

Review the suggestions and current guidelines. Create an updated version that:
- Deduplicates similar guidelines
- Resolves any conflicts
- Keeps each guideline focused on one concept
- Orders guidelines from most to least commonly needed
- Minimizes token count while preserving effectiveness
- Uses specific examples where helpful
- Each guideline should be 50-100 tokens

Return ONLY the updated guidelines text, no commentary.`;

  const result = await generateText({
    model: anthropic(MODEL_ID) as LanguageModel,
    prompt,
    temperature: 0.7,
  });

  return result.text;
}

async function generateRefinementProposal(
  currentGuidelines: string,
  logger: Logger
): Promise<string> {
  const prompt = `You are an expert at refining guidelines for AI code generation.

## Current Guidelines
${currentGuidelines}

## Your Task

Propose ONE refinement to make these guidelines more concise while maintaining effectiveness:
- Remove a guideline you suspect is unnecessary
- Combine overlapping guidelines
- Simplify wording while preserving meaning

Be conservative - only make changes you're confident won't break the evals.

Return ONLY the refined guidelines text, no commentary.`;

  const result = await generateText({
    model: anthropic(MODEL_ID) as LanguageModel,
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
