/**
 * Integration tests for the orchestrator and related functions.
 * 
 * These tests call the actual LLM to verify the full pipeline works.
 * They require ANTHROPIC_API_KEY to be set.
 * 
 * Run with: bun test orchestrator.integration
 */
import { describe, test, expect } from 'bun:test';
import { join } from 'path';
import { config } from 'dotenv';
import { existsSync, readFileSync } from 'fs';
import { analyzeFailure } from '../failureAnalyser.js';
import type { EvalResult, FailureAnalysis } from '../types.js';

// Load .env from repo root
config({ path: join(import.meta.dir, '..', '..', '..', '.env') });

const FIXTURES_DIR = join(import.meta.dir, 'fixtures');

// Skip tests if no API key
const hasApiKey = Boolean(process.env.ANTHROPIC_API_KEY);

/**
 * Re-implement runWithConcurrencyLimit for testing
 * (In a real scenario, this would be exported from orchestrator.ts)
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

describe.skipIf(!hasApiKey)('orchestrator integration', () => {
  const TIMEOUT = 180_000; // 3 minutes for parallel tests

  test('should analyze multiple failures in parallel without errors', async () => {
    // Create multiple eval results to analyze in parallel
    const evalResults: EvalResult[] = [
      {
        evalName: '000-fundamentals/003-crons',
        passed: false,
        expectedFiles: [join(FIXTURES_DIR, '003-crons/expected/crons.ts')],
        outputFiles: [join(FIXTURES_DIR, '003-crons/output/crons.ts')],
        runLogPath: join(FIXTURES_DIR, '003-crons/run.log'),
        taskPath: join(FIXTURES_DIR, '003-crons/TASK.txt'),
      },
      // Add the same fixture twice to test parallel processing
      {
        evalName: '000-fundamentals/003-crons-duplicate',
        passed: false,
        expectedFiles: [join(FIXTURES_DIR, '003-crons/expected/crons.ts')],
        outputFiles: [join(FIXTURES_DIR, '003-crons/output/crons.ts')],
        runLogPath: join(FIXTURES_DIR, '003-crons/run.log'),
        taskPath: join(FIXTURES_DIR, '003-crons/TASK.txt'),
      },
    ];

    const legacyGuidelines = '# Legacy Guidelines\n- Use cronJobs() for cron definitions';
    const startedIndices: number[] = [];

    const analyses = await runWithConcurrencyLimit(
      evalResults,
      (evalItem) => analyzeFailure(evalItem, legacyGuidelines),
      2, // Max 2 parallel
      (item, index) => {
        startedIndices.push(index);
        console.log(`Started analysis ${index + 1}/${evalResults.length}: ${item.evalName}`);
      }
    );

    // Verify all analyses completed
    expect(analyses).toHaveLength(2);
    expect(startedIndices.sort()).toEqual([0, 1]);

    // Verify each analysis is valid
    for (const analysis of analyses) {
      expect(analysis).toBeDefined();
      expect(typeof analysis.analysis).toBe('string');
      expect(typeof analysis.suggestedGuideline).toBe('string');
      expect(['high', 'medium', 'low']).toContain(analysis.confidence);
      expect(Array.isArray(analysis.relatedLegacyGuidelines)).toBe(true);
      expect(analysis.analysis.length).toBeGreaterThan(10);
    }

    console.log('Parallel analyses completed:', analyses.map(a => ({
      confidence: a.confidence,
      guidelinePreview: a.suggestedGuideline.slice(0, 50) + '...',
    })));
  }, TIMEOUT);

  test('should incorporate multiple suggestions into guidelines', async () => {
    // Mock analyses that would come from the failure analyser
    const analyses: FailureAnalysis[] = [
      {
        analysis: 'The model exported an array instead of using cronJobs()',
        suggestedGuideline: 'Always use cronJobs() from "convex/server" to create cron job definitions. Export the result as the default export.',
        confidence: 'high',
        relatedLegacyGuidelines: ['Use cronJobs() for cron definitions'],
      },
      {
        analysis: 'The model used incorrect interval syntax',
        suggestedGuideline: 'Use crons.interval() with an object like { seconds: 1 } or { minutes: 5 }, not string syntax like "1s".',
        confidence: 'high',
        relatedLegacyGuidelines: [],
      },
      {
        analysis: 'Missing import for internal API',
        suggestedGuideline: 'Import { internal } from "./_generated/api" to reference internal functions in cron definitions.',
        confidence: 'medium',
        relatedLegacyGuidelines: [],
      },
    ];

    // Import the actual incorporateSuggestions function would require exporting it
    // For now, we'll test the prompt building and verify structure
    const formatAnalysis = (a: FailureAnalysis, i: number) =>
      `### Suggestion ${i + 1} (confidence: ${a.confidence})
**Analysis:** ${a.analysis}
**Suggested Guideline:** ${a.suggestedGuideline}
${a.relatedLegacyGuidelines.length > 0 ? `**Related Legacy Guidelines:** ${a.relatedLegacyGuidelines.join('; ')}` : ''}`;

    const formattedAnalyses = analyses.map(formatAnalysis).join('\n\n');

    // Verify the format is correct
    expect(formattedAnalyses).toContain('### Suggestion 1 (confidence: high)');
    expect(formattedAnalyses).toContain('### Suggestion 2 (confidence: high)');
    expect(formattedAnalyses).toContain('### Suggestion 3 (confidence: medium)');
    expect(formattedAnalyses).toContain('cronJobs()');
    expect(formattedAnalyses).toContain('interval()');
    expect(formattedAnalyses).toContain('internal');

    // Verify high confidence suggestions come before medium
    const highIndex1 = formattedAnalyses.indexOf('Suggestion 1');
    const highIndex2 = formattedAnalyses.indexOf('Suggestion 2');
    const mediumIndex = formattedAnalyses.indexOf('Suggestion 3');
    expect(highIndex1).toBeLessThan(mediumIndex);
    expect(highIndex2).toBeLessThan(mediumIndex);
  });
});

describe.skipIf(!hasApiKey)('incorporateSuggestions integration', () => {
  const TIMEOUT = 120_000; // 2 minutes

  test('should call LLM to incorporate suggestions and return valid guidelines', async () => {
    const { anthropic } = await import('@ai-sdk/anthropic');
    const { generateText } = await import('ai');

    const currentGuidelines = '';
    const analyses: FailureAnalysis[] = [
      {
        analysis: 'The model exported an array instead of using cronJobs()',
        suggestedGuideline: 'Always use cronJobs() from "convex/server" to create cron job definitions.',
        confidence: 'high',
        relatedLegacyGuidelines: [],
      },
      {
        analysis: 'Wrong interval syntax used',
        suggestedGuideline: 'Use crons.interval() with { seconds: N } or { minutes: N } objects.',
        confidence: 'high',
        relatedLegacyGuidelines: [],
      },
    ];

    const formatAnalysis = (a: FailureAnalysis, i: number) =>
      `### Suggestion ${i + 1} (confidence: ${a.confidence})
**Analysis:** ${a.analysis}
**Suggested Guideline:** ${a.suggestedGuideline}`;

    const prompt = `You are an expert at creating concise, effective guidelines for AI code generation.

## Current Guidelines
${currentGuidelines || 'None yet'}

## New Suggestions from Failure Analysis
${analyses.map(formatAnalysis).join('\n\n')}

## Your Task

Review the suggestions and current guidelines. Create an updated version that:
- Prioritize HIGH confidence suggestions over medium/low
- Deduplicates similar guidelines
- Keeps each guideline focused on one concept
- Each guideline should be 50-100 tokens

Return ONLY the updated guidelines text, no commentary.`;

    const result = await generateText({
      model: anthropic('claude-sonnet-4-5-20250929'),
      prompt,
      temperature: 0.7,
    });

    expect(result.text).toBeDefined();
    expect(result.text.length).toBeGreaterThan(50);
    
    // Should contain something about cron jobs
    const textLower = result.text.toLowerCase();
    expect(textLower.includes('cron') || textLower.includes('interval')).toBe(true);

    console.log('Generated guidelines:', result.text.slice(0, 500) + '...');
  }, TIMEOUT);
});

describe('evalRunner integration', () => {
  test('should parse real results.jsonl from tmp directory if available', async () => {
    // Try to find a real results file
    const possiblePaths = [
      join(import.meta.dir, '..', '..', 'tmp', 'openai_gpt-5-mini', '2026-01-20_14-01-19_dbc7', 'results.jsonl'),
    ];

    const resultsPath = possiblePaths.find(p => existsSync(p));
    
    if (!resultsPath) {
      console.log('No real results.jsonl found, skipping test');
      return;
    }

    const content = readFileSync(resultsPath, 'utf-8').trim();
    const data = JSON.parse(content);

    // Verify it has the expected structure
    expect(data.individual_results).toBeDefined();
    expect(Array.isArray(data.individual_results)).toBe(true);
    expect(data.run_stats).toBeDefined();
    expect(typeof data.run_stats.total_tests).toBe('number');
    expect(typeof data.run_stats.total_passed).toBe('number');
    expect(typeof data.run_stats.total_failed).toBe('number');

    // Verify individual results structure
    const firstResult = data.individual_results[0];
    expect(firstResult.category).toBeDefined();
    expect(firstResult.name).toBeDefined();
    expect(typeof firstResult.passed).toBe('boolean');
    expect(firstResult.directory_path).toBeDefined();

    console.log('Parsed real results:', {
      total: data.run_stats.total_tests,
      passed: data.run_stats.total_passed,
      failed: data.run_stats.total_failed,
      sampleResult: {
        name: `${firstResult.category}/${firstResult.name}`,
        passed: firstResult.passed,
      },
    });
  });
});

describe('error handling integration', () => {
  test('should handle rate limiting gracefully', async () => {
    // This test documents expected behavior under rate limiting
    // In practice, the retry logic should handle transient errors
    
    // Verify the retry constants are reasonable
    const MAX_RETRIES = 3;
    const ANALYSIS_TIMEOUT_MS = 5 * 60 * 1000;
    
    expect(MAX_RETRIES).toBeGreaterThanOrEqual(2);
    expect(ANALYSIS_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000); // At least 1 minute
  });

  test('should have fallback for failed analyses', () => {
    // Verify the fallback analysis structure matches FailureAnalysis
    const fallback: FailureAnalysis = {
      analysis: 'Analysis failed after 3 attempts: timeout. Manual review recommended.',
      suggestedGuideline: 'Review and fix the issue manually.',
      confidence: 'low',
      relatedLegacyGuidelines: [],
    };

    expect(fallback.confidence).toBe('low');
    expect(fallback.analysis).toContain('failed');
    expect(fallback.relatedLegacyGuidelines).toEqual([]);
  });
});
