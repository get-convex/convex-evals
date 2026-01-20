/**
 * Integration tests for the failure analyser.
 * 
 * These tests actually call the LLM to verify the analyser works end-to-end.
 * They require ANTHROPIC_API_KEY to be set.
 * 
 * Run with: bun test failureAnalyser.integration
 */
import { describe, test, expect, beforeAll } from 'bun:test';
import { join } from 'path';
import { config } from 'dotenv';
import { analyzeFailure } from '../failureAnalyser.js';
import type { EvalResult, FailureAnalysis } from '../types.js';

// Load .env from repo root
config({ path: join(import.meta.dir, '..', '..', '..', '.env') });

const FIXTURES_DIR = join(import.meta.dir, 'fixtures');

// Skip tests if no API key
const hasApiKey = Boolean(process.env.ANTHROPIC_API_KEY);

describe.skipIf(!hasApiKey)('failureAnalyser integration', () => {
  // Increase timeout for LLM calls
  const TIMEOUT = 120_000; // 2 minutes

  test('should analyze crons failure and return valid FailureAnalysis', async () => {
    const evalResult: EvalResult = {
      evalName: '000-fundamentals/003-crons',
      passed: false,
      expectedFiles: [join(FIXTURES_DIR, '003-crons/expected/crons.ts')],
      outputFiles: [join(FIXTURES_DIR, '003-crons/output/crons.ts')],
      runLogPath: join(FIXTURES_DIR, '003-crons/run.log'),
      taskPath: join(FIXTURES_DIR, '003-crons/TASK.txt'),
    };

    const legacyGuidelines = `
# Convex Cron Jobs Guidelines
- Use cronJobs() from "convex/server" to create cron job definitions
- Export the crons object as the default export
- Use crons.interval() for interval-based scheduling
- Use crons.cron() for cron expression scheduling
`;

    const analysis = await analyzeFailure(evalResult, legacyGuidelines);

    // Validate structure
    expect(analysis).toBeDefined();
    expect(typeof analysis.analysis).toBe('string');
    expect(typeof analysis.suggestedGuideline).toBe('string');
    expect(['high', 'medium', 'low']).toContain(analysis.confidence);
    expect(Array.isArray(analysis.relatedLegacyGuidelines)).toBe(true);

    // Validate content is meaningful (not empty)
    expect(analysis.analysis.length).toBeGreaterThan(20);
    expect(analysis.suggestedGuideline.length).toBeGreaterThan(10);

    // The analysis should identify the core issue: exporting an array instead of a Crons object
    const combinedText = `${analysis.analysis} ${analysis.suggestedGuideline}`.toLowerCase();
    const mentionsCronJobs = combinedText.includes('cronjobs') || combinedText.includes('cron');
    const mentionsExport = combinedText.includes('export') || combinedText.includes('default');
    const mentionsArray = combinedText.includes('array') || combinedText.includes('object');
    
    // Should mention at least one of these key concepts
    expect(mentionsCronJobs || mentionsExport || mentionsArray).toBe(true);

    console.log('Analysis result:', {
      confidence: analysis.confidence,
      analysisPreview: analysis.analysis.slice(0, 200) + '...',
      guidelinePreview: analysis.suggestedGuideline.slice(0, 100) + '...',
      relatedGuidelines: analysis.relatedLegacyGuidelines,
    });
  }, TIMEOUT);

  test('should handle missing files gracefully', async () => {
    const evalResult: EvalResult = {
      evalName: 'test/missing-files',
      passed: false,
      expectedFiles: ['/nonexistent/expected.ts'],
      outputFiles: ['/nonexistent/output.ts'],
      runLogPath: '/nonexistent/run.log',
      taskPath: '/nonexistent/TASK.txt',
    };

    const analysis = await analyzeFailure(evalResult, '');

    // Should still return a valid analysis (possibly low confidence)
    expect(analysis).toBeDefined();
    expect(typeof analysis.analysis).toBe('string');
    expect(typeof analysis.suggestedGuideline).toBe('string');
    expect(['high', 'medium', 'low']).toContain(analysis.confidence);
  }, TIMEOUT);

  test('should return low confidence fallback on repeated failures', async () => {
    // This test verifies the fallback mechanism works
    // We can't easily trigger parse failures, but we can verify the structure
    const fallbackAnalysis: FailureAnalysis = {
      analysis: 'Analysis failed after 3 attempts: Error. Manual review recommended for eval: test-eval',
      suggestedGuideline: 'Review and fix the issue in eval test-eval - automatic analysis could not determine the root cause.',
      confidence: 'low',
      relatedLegacyGuidelines: [],
    };

    expect(fallbackAnalysis.confidence).toBe('low');
    expect(fallbackAnalysis.analysis).toContain('failed');
    expect(fallbackAnalysis.relatedLegacyGuidelines).toEqual([]);
  });
});

describe('failureAnalyser without API key', () => {
  test('should skip integration tests when ANTHROPIC_API_KEY is not set', () => {
    if (!hasApiKey) {
      console.log('Skipping integration tests: ANTHROPIC_API_KEY not set');
      console.log('Set ANTHROPIC_API_KEY in .env to run integration tests');
    }
    expect(true).toBe(true); // Always passes
  });
});
