#!/usr/bin/env bun
import { select, input, confirm } from '@inquirer/prompts';
import { Command } from 'commander';
import { readdirSync, existsSync, rmSync, statSync, readFileSync } from 'fs';
import { join } from 'path';
import type { ModelStatus } from './types.js';
import {
  readGuidelines,
  getCommittedGuidelinesPath,
  getTmpModelDir,
  countTokens,
  getModelSlug,
} from './guidelineStore.js';
import { readLockFile, isProcessRunning } from './lockFile.js';
import { runOrchestrator } from './orchestrator.js';

interface ModelChoice {
  name: string;
  value: string;
  provider: string;
}

const MODELS_FILE = join(import.meta.dir, '..', '..', 'runner', 'models', '__init__.py');

/**
 * Parses the Python models file to extract available models.
 * This keeps the CLI in sync with the Python runner without duplication.
 */
function discoverModels(): ModelChoice[] {
  try {
    const content = readFileSync(MODELS_FILE, 'utf-8');

    const models: ModelChoice[] = [];

    // Match ModelTemplate entries - the format spans multiple lines
    const modelBlockRegex =
      /ModelTemplate\([\s\S]*?provider=ModelProvider\.(\w+)[\s\S]*?\),/g;

    let blockMatch;
    while ((blockMatch = modelBlockRegex.exec(content)) !== null) {
      const block = blockMatch[0];
      const provider = blockMatch[1];

      // Extract name and formatted_name from the block
      const nameMatch = block.match(/name="([^"]+)"/);
      const formattedNameMatch = block.match(/formatted_name="([^"]+)"/);

      if (nameMatch && formattedNameMatch) {
        models.push({
          name: formattedNameMatch[1],
          value: nameMatch[1],
          provider: provider.toLowerCase(),
        });
      }
    }

    return models;
  } catch (error) {
    console.error('Warning: Could not read models from Python file:', error);
    return [];
  }
}

const KNOWN_MODELS = discoverModels();

const program = new Command();

program
  .name('generate-guidelines')
  .description('Interactive CLI for Convex guidelines generation')
  .version('1.0.0');

program
  .command('status')
  .description('View status of all models')
  .action(async () => {
    const statuses = getModelStatuses();
    displayStatuses(statuses);
  });

program
  .command('history')
  .description('View run history for a model')
  .option('--model <model>', 'Model name')
  .action(async (options) => {
    let provider: string;
    let model: string;

    if (options.model) {
      const parsed = parseModelString(options.model);
      provider = parsed.provider;
      model = parsed.model;
    } else {
      const selected = await selectModel();
      provider = selected.provider;
      model = selected.model;
    }

    displayHistory(provider, model);
  });

program
  .command('clean')
  .description('Clean temp files')
  .option('--model <model>', 'Model name (cleans all if not specified)')
  .option('--keep <n>', 'Keep only the most recent N runs', parseInt)
  .action(async (options) => {
    if (options.model) {
      const parsed = parseModelString(options.model);
      cleanModel(parsed.provider, parsed.model, options.keep);
    } else {
      const shouldClean = await confirm({
        message: 'Clean temp files for ALL models?',
        default: false,
      });

      if (shouldClean) cleanAll();
    }
  });

program
  .option('--model <model>', 'Start directly for a specific model')
  .option('--filter <filter>', 'Test filter pattern')
  .action(async (options) => {
    if (options.model) {
      const parsed = parseModelString(options.model);
      await startGeneration(parsed.provider, parsed.model, options.filter);
    } else {
      await interactiveMenu(options.filter);
    }
  });

program.parse();

async function interactiveMenu(filter?: string) {
  while (true) {
    console.log('\n🧪 Convex Guidelines Generator\n');

    const statuses = getModelStatuses();
    displayStatuses(statuses);

    const action = await select({
      message: 'What would you like to do?',
      choices: [
        { name: 'Start/resume guidelines generation', value: 'start' },
        { name: 'View model status (detailed)', value: 'status' },
        { name: 'View run history for a model', value: 'history' },
        { name: 'View logs for a model', value: 'logs' },
        { name: 'Clean temp files', value: 'clean' },
        { name: 'Exit', value: 'exit' },
      ],
    });

    if (action === 'exit') break;

    switch (action) {
      case 'start': {
        const selected = await selectModel();
        await startGeneration(selected.provider, selected.model, filter);
        break;
      }
      case 'status': {
        const selected = await selectModel();
        displayDetailedStatus(selected.provider, selected.model);
        break;
      }
      case 'history': {
        const selected = await selectModel();
        displayHistory(selected.provider, selected.model);
        break;
      }
      case 'logs': {
        const selected = await selectModel();
        displayLogs(selected.provider, selected.model);
        break;
      }
      case 'clean': {
        const cleanAction = await select({
          message: 'What to clean?',
          choices: [
            { name: 'Clean specific model', value: 'model' },
            { name: 'Clean all models', value: 'all' },
            { name: 'Back', value: 'back' },
          ],
        });

        if (cleanAction === 'model') {
          const selected = await selectModel();
          const keep = await input({
            message: 'Keep most recent N runs (leave empty to delete all):',
            default: '',
          });
          cleanModel(selected.provider, selected.model, keep ? parseInt(keep) : undefined);
        } else if (cleanAction === 'all') {
          const shouldClean = await confirm({
            message: 'Clean temp files for ALL models?',
            default: false,
          });
          if (shouldClean) cleanAll();
        }
        break;
      }
    }
  }
}

async function selectModel(): Promise<{ provider: string; model: string }> {
  const statuses = getModelStatuses();

  const choices = [
    ...statuses.map(s => ({
      name: `${s.provider}/${s.model} (${getStatusIcon(s.status)})`,
      value: `${s.provider}:${s.model}`,
    })),
    { name: '[Enter custom model]', value: 'custom' },
  ];

  const selected = await select({
    message: 'Select model:',
    choices,
  });

  if (selected === 'custom') {
    const modelStr = await input({
      message: 'Enter model (format: provider/model or provider:model):',
    });
    return parseModelString(modelStr);
  }

  const [provider, model] = selected.split(':');
  return { provider, model };
}

function parseModelString(modelStr: string): { provider: string; model: string } {
  const parts = modelStr.split(/[/:]/);
  if (parts.length === 2) {
    return { provider: parts[0], model: parts[1] };
  }
  throw new Error(`Invalid model format: ${modelStr}. Use provider/model or provider:model`);
}

function getModelStatuses(): ModelStatus[] {
  return KNOWN_MODELS.map(({ provider, value: model }) => {
    const lockFile = readLockFile(provider, model);
    const guidelines = readGuidelines(provider, model);

    let status: ModelStatus['status'];
    if (lockFile) {
      status = isProcessRunning(lockFile.pid) ? 'running' : 'paused';
    } else if (guidelines) {
      status = 'complete';
    } else {
      status = 'not-started';
    }

    return {
      model,
      provider,
      status,
      lockFile: lockFile ?? undefined,
      guidelineTokens: guidelines ? countTokens(guidelines) : undefined,
      lastUpdate: lockFile?.updatedAt,
    };
  });
}

function getStatusIcon(status: ModelStatus['status']): string {
  switch (status) {
    case 'running':
      return '🔄 Running';
    case 'paused':
      return '⏸️  Paused';
    case 'complete':
      return '✅ Complete';
    case 'not-started':
      return '❌ Not started';
  }
}

function displayStatuses(statuses: ModelStatus[]) {
  console.log('Current Status:');
  for (const s of statuses) {
    const icon = getStatusIcon(s.status);
    const tokens = s.guidelineTokens ? `${s.guidelineTokens} tokens` : '';
    const extra =
      s.lockFile && s.lockFile.lastEvalResult
        ? `(${s.lockFile.lastEvalResult.passed}/${s.lockFile.lastEvalResult.total} passing)`
        : '';

    console.log(`  ${s.provider}/${s.model.padEnd(20)} ${icon} ${extra} ${tokens}`);
  }
  console.log();
}

function displayDetailedStatus(provider: string, model: string) {
  const lockFile = readLockFile(provider, model);
  const guidelines = readGuidelines(provider, model);

  console.log(`\n=== ${provider}/${model} ===\n`);

  if (lockFile) {
    console.log(`Status: ${isProcessRunning(lockFile.pid) ? 'Running' : 'Paused'}`);
    console.log(`Run ID: ${lockFile.runId}`);
    console.log(`PID: ${lockFile.pid}`);
    console.log(`Phase: ${lockFile.phase}`);
    console.log(`Iteration: ${lockFile.iteration}`);
    console.log(`Current Action: ${lockFile.currentAction || 'N/A'}`);

    if (lockFile.lastEvalResult) {
      const { passed, failed, total } = lockFile.lastEvalResult;
      console.log(
        `Last Eval: ${passed}/${total} passed (${failed} failed) - ${Math.round((passed / total) * 100)}%`
      );
    }

    console.log(`Last Update: ${new Date(lockFile.updatedAt).toLocaleString()}`);
  } else if (guidelines) {
    console.log('Status: Complete');
    console.log(`Guidelines: ${countTokens(guidelines)} tokens`);
  } else {
    console.log('Status: Not started');
  }

  console.log();
}

function displayHistory(provider: string, model: string) {
  const tmpDir = getTmpModelDir(provider, model);

  if (!existsSync(tmpDir)) {
    console.log(`\nNo history found for ${provider}/${model}\n`);
    return;
  }

  const runs = readdirSync(tmpDir)
    .filter(name => name !== '.lock' && statSync(join(tmpDir, name)).isDirectory())
    .map(runId => {
      const runDir = join(tmpDir, runId);
      const stat = statSync(runDir);
      return { runId, modified: stat.mtime };
    })
    .sort((a, b) => b.modified.getTime() - a.modified.getTime());

  console.log(`\n=== Run History for ${provider}/${model} ===\n`);

  if (runs.length === 0) {
    console.log('No runs found\n');
    return;
  }

  for (const run of runs) {
    console.log(`  ${run.runId} - ${run.modified.toLocaleString()}`);
  }

  console.log();
}

function displayLogs(provider: string, model: string) {
  const lockFile = readLockFile(provider, model);

  if (!lockFile) {
    console.log(`\nNo active run for ${provider}/${model}\n`);
    return;
  }

  const logPath = join(getTmpModelDir(provider, model), lockFile.runId, 'logs', 'orchestrator.log');

  if (!existsSync(logPath)) {
    console.log(`\nLog file not found: ${logPath}\n`);
    return;
  }

  const { readFileSync } = require('fs');
  const logs = readFileSync(logPath, 'utf-8');
  console.log(`\n=== Logs for ${provider}/${model} (${lockFile.runId}) ===\n`);
  console.log(logs);
}

function cleanModel(provider: string, model: string, keepRecent?: number) {
  const tmpDir = getTmpModelDir(provider, model);

  if (!existsSync(tmpDir)) {
    console.log(`\nNo temp files for ${provider}/${model}\n`);
    return;
  }

  const runs = readdirSync(tmpDir)
    .filter(name => name !== '.lock' && statSync(join(tmpDir, name)).isDirectory())
    .map(runId => {
      const runDir = join(tmpDir, runId);
      const stat = statSync(runDir);
      return { runId, runDir, modified: stat.mtime };
    })
    .sort((a, b) => b.modified.getTime() - a.modified.getTime());

  const toDelete = keepRecent ? runs.slice(keepRecent) : runs;

  for (const run of toDelete) {
    console.log(`Deleting run: ${run.runId}`);
    rmSync(run.runDir, { recursive: true, force: true });
  }

  console.log(`\nCleaned ${toDelete.length} runs for ${provider}/${model}\n`);
}

function cleanAll() {
  const tmpRoot = join(import.meta.dir, '..', 'tmp');

  if (!existsSync(tmpRoot)) {
    console.log('\nNo temp files found\n');
    return;
  }

  rmSync(tmpRoot, { recursive: true, force: true });
  console.log('\nAll temp files cleaned\n');
}

async function startGeneration(provider: string, model: string, filter?: string) {
  console.log(`\n🚀 Starting guideline generation for ${provider}/${model}\n`);

  try {
    await runOrchestrator({ model, provider, filter });
    console.log('\n✅ Generation complete!\n');
  } catch (error) {
    console.error('\n❌ Generation failed:', error);
    throw error;
  }
}
