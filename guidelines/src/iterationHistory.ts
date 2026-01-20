import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import type { IterationRecord, IterationHistory, IterationFeedback } from './types.js';
import { getTmpModelDir } from './guidelineStore.js';
import { countTokens } from './guidelineStore.js';

const MAX_HISTORY_ITERATIONS = 20;

/**
 * Get the path to the iteration history file for a model
 */
export function getIterationHistoryPath(provider: string, model: string): string {
  return `${getTmpModelDir(provider, model)}/iteration_history.json`;
}

/**
 * Read iteration history from disk
 */
export function readIterationHistory(provider: string, model: string): IterationHistory {
  const path = getIterationHistoryPath(provider, model);
  if (!existsSync(path)) {
    return { iterations: [] };
  }

  try {
    const content = readFileSync(path, 'utf-8');
    const history: IterationHistory = JSON.parse(content);
    // Ensure it's valid
    if (!history.iterations || !Array.isArray(history.iterations)) {
      return { iterations: [] };
    }
    return history;
  } catch (error) {
    console.warn(`Failed to read iteration history: ${error}`);
    return { iterations: [] };
  }
}

/**
 * Append a new iteration record to the history
 */
export function appendIterationRecord(
  provider: string,
  model: string,
  record: IterationRecord
): void {
  const history = readIterationHistory(provider, model);
  history.iterations.push(record);

  // Keep only the last MAX_HISTORY_ITERATIONS
  if (history.iterations.length > MAX_HISTORY_ITERATIONS) {
    history.iterations = history.iterations.slice(-MAX_HISTORY_ITERATIONS);
  }

  const path = getIterationHistoryPath(provider, model);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(history, null, 2), 'utf-8');
}

/**
 * Compute feedback comparing current iteration to previous one
 */
export function computeIterationFeedback(
  history: IterationHistory,
  currentIteration: number
): IterationFeedback | null {
  if (history.iterations.length < 2) return null;

  const current = history.iterations[history.iterations.length - 1];
  const previous = history.iterations[history.iterations.length - 2];

  if (current.iteration !== currentIteration) return null;

  const passCountDelta = current.passCount - previous.passCount;

  // Find evals that flipped state
  const evalsFlippedToPass: string[] = [];
  const evalsFlippedToFail: string[] = [];

  for (const evalName in current.evalResults) {
    const currentPassed = current.evalResults[evalName];
    const previousPassed = previous.evalResults[evalName];

    if (previousPassed === undefined) continue; // New eval

    if (!previousPassed && currentPassed) {
      evalsFlippedToPass.push(evalName);
    } else if (previousPassed && !currentPassed) {
      evalsFlippedToFail.push(evalName);
    }
  }

  return {
    previousIteration: previous.iteration,
    currentIteration: current.iteration,
    passCountDelta,
    evalsFlippedToPass,
    evalsFlippedToFail,
    changesMade: current.guidelinesDiff || 'No summary available',
  };
}

/**
 * Summarize what changed between two guideline versions
 */
export function summarizeGuidelinesDiff(before: string, after: string): string {
  const beforeTokens = countTokens(before);
  const afterTokens = countTokens(after);
  const tokenDelta = afterTokens - beforeTokens;

  // Simple heuristic: if token count changed significantly, describe it
  if (Math.abs(tokenDelta) < 50) {
    return 'Minor refinements (similar token count)';
  }

  if (tokenDelta > 100) {
    return `Added ~${tokenDelta} tokens (new guidelines added)`;
  }

  if (tokenDelta < -100) {
    return `Removed ~${Math.abs(tokenDelta)} tokens (guidelines simplified or removed)`;
  }

  // For moderate changes, try to identify sections
  const beforeSections = (before.match(/^## .+$/gm) || []).length;
  const afterSections = (after.match(/^## .+$/gm) || []).length;

  if (afterSections > beforeSections) {
    return `Added ${afterSections - beforeSections} new section(s) (+${tokenDelta} tokens)`;
  }

  if (afterSections < beforeSections) {
    return `Removed ${beforeSections - afterSections} section(s) (${tokenDelta} tokens)`;
  }

  return `Modified guidelines (${tokenDelta > 0 ? '+' : ''}${tokenDelta} tokens)`;
}

/**
 * Update the guidelines diff for the last iteration record
 */
export function updateLastIterationDiff(
  provider: string,
  model: string,
  diff: string
): void {
  const history = readIterationHistory(provider, model);
  if (history.iterations.length === 0) return;

  const lastRecord = history.iterations[history.iterations.length - 1];
  lastRecord.guidelinesDiff = diff;

  const path = getIterationHistoryPath(provider, model);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(history, null, 2), 'utf-8');
}

/**
 * Get all feedback entries for recent iterations (for incorporator context)
 */
export function getRecentIterationFeedback(
  history: IterationHistory,
  maxEntries: number = 5
): IterationFeedback[] {
  const feedback: IterationFeedback[] = [];

  for (let i = history.iterations.length - 1; i >= 1 && feedback.length < maxEntries; i--) {
    const current = history.iterations[i];
    const previous = history.iterations[i - 1];

    const passCountDelta = current.passCount - previous.passCount;

    const evalsFlippedToPass: string[] = [];
    const evalsFlippedToFail: string[] = [];

    for (const evalName in current.evalResults) {
      const currentPassed = current.evalResults[evalName];
      const previousPassed = previous.evalResults[evalName];

      if (previousPassed === undefined) continue;

      if (!previousPassed && currentPassed) {
        evalsFlippedToPass.push(evalName);
      } else if (previousPassed && !currentPassed) {
        evalsFlippedToFail.push(evalName);
      }
    }

    feedback.unshift({
      previousIteration: previous.iteration,
      currentIteration: current.iteration,
      passCountDelta,
      evalsFlippedToPass,
      evalsFlippedToFail,
      changesMade: current.guidelinesDiff || 'No summary available',
    });
  }

  return feedback;
}
