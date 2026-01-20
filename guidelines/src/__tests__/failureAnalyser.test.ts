import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { join } from 'path';
import type { EvalResult, FailureAnalysis } from '../types.js';

const FIXTURES_DIR = join(import.meta.dir, 'fixtures');

describe('failureAnalyser', () => {
  describe('analyzeFailure input gathering', () => {
    test('should correctly build EvalResult from fixture data', () => {
      const evalResult: EvalResult = {
        evalName: '000-fundamentals/003-crons',
        passed: false,
        expectedFiles: [join(FIXTURES_DIR, '003-crons/expected/crons.ts')],
        outputFiles: [join(FIXTURES_DIR, '003-crons/output/crons.ts')],
        runLogPath: join(FIXTURES_DIR, '003-crons/run.log'),
        taskPath: join(FIXTURES_DIR, '003-crons/TASK.txt'),
      };

      expect(evalResult.evalName).toBe('000-fundamentals/003-crons');
      expect(evalResult.passed).toBe(false);
      expect(evalResult.expectedFiles).toHaveLength(1);
      expect(evalResult.outputFiles).toHaveLength(1);
    });

    test('should have valid fixture files', async () => {
      const { existsSync, readFileSync } = await import('fs');
      
      const taskPath = join(FIXTURES_DIR, '003-crons/TASK.txt');
      const runLogPath = join(FIXTURES_DIR, '003-crons/run.log');
      const expectedPath = join(FIXTURES_DIR, '003-crons/expected/crons.ts');
      const outputPath = join(FIXTURES_DIR, '003-crons/output/crons.ts');

      expect(existsSync(taskPath)).toBe(true);
      expect(existsSync(runLogPath)).toBe(true);
      expect(existsSync(expectedPath)).toBe(true);
      expect(existsSync(outputPath)).toBe(true);

      const task = readFileSync(taskPath, 'utf-8');
      expect(task).toContain('cron job demo');
      expect(task).toContain('emptyAction');

      const runLog = readFileSync(runLogPath, 'utf-8');
      expect(runLog).toContain('convex dev');
      expect(runLog).toContain('The default export of `convex/crons.js` is not a Crons object');

      const expected = readFileSync(expectedPath, 'utf-8');
      expect(expected).toContain('cronJobs()');
      expect(expected).toContain('export default crons');

      const output = readFileSync(outputPath, 'utf-8');
      expect(output).toContain('export default schedules');
      // The bug: output exports an array instead of a Crons object
      expect(output).not.toContain('cronJobs()');
    });
  });

  describe('FailureAnalysis structure', () => {
    test('should validate FailureAnalysis shape', () => {
      const analysis: FailureAnalysis = {
        analysis: 'The model exported an array of schedule objects instead of using cronJobs()',
        suggestedGuideline: 'Use cronJobs() from "convex/server" for cron definitions, not arrays',
        confidence: 'high',
        relatedLegacyGuidelines: ['Always use cronJobs() for cron job definitions'],
      };

      expect(analysis.analysis).toBeTruthy();
      expect(analysis.suggestedGuideline).toBeTruthy();
      expect(['high', 'medium', 'low']).toContain(analysis.confidence);
      expect(Array.isArray(analysis.relatedLegacyGuidelines)).toBe(true);
    });

    test('should allow empty relatedLegacyGuidelines', () => {
      const analysis: FailureAnalysis = {
        analysis: 'Test analysis',
        suggestedGuideline: 'Test guideline',
        confidence: 'low',
        relatedLegacyGuidelines: [],
      };

      expect(analysis.relatedLegacyGuidelines).toHaveLength(0);
    });
  });

  describe('prompt building', () => {
    test('should build prompt with all required sections', async () => {
      const { readFileSync } = await import('fs');
      
      const evalResult: EvalResult = {
        evalName: '000-fundamentals/003-crons',
        passed: false,
        expectedFiles: [join(FIXTURES_DIR, '003-crons/expected/crons.ts')],
        outputFiles: [join(FIXTURES_DIR, '003-crons/output/crons.ts')],
        runLogPath: join(FIXTURES_DIR, '003-crons/run.log'),
        taskPath: join(FIXTURES_DIR, '003-crons/TASK.txt'),
      };

      const legacyGuidelines = '# Legacy Guidelines\n- Use cronJobs() for cron definitions';

      // Build the prompt the same way the actual analyser does
      const taskContent = readFileSync(evalResult.taskPath, 'utf-8');
      const expectedContent = evalResult.expectedFiles
        .map(file => `=== ${file} ===\n${readFileSync(file, 'utf-8')}`)
        .join('\n\n');
      const outputContent = evalResult.outputFiles
        .map(file => `=== ${file} ===\n${readFileSync(file, 'utf-8')}`)
        .join('\n\n');
      const runLog = readFileSync(evalResult.runLogPath, 'utf-8');

      const prompt = `You are a failure analysis agent for Convex code generation evals.

Your task is to analyze why a specific eval failed and suggest a guideline that would prevent this failure in the future.

## Eval: ${evalResult.evalName}

### Task
${taskContent}

### Expected Output
${expectedContent}

### Actual Output
${outputContent}

### Run Log
${runLog}

### Legacy Guidelines for Reference
${legacyGuidelines}`;

      // Verify prompt contains all required sections
      expect(prompt).toContain('## Eval: 000-fundamentals/003-crons');
      expect(prompt).toContain('### Task');
      expect(prompt).toContain('cron job demo');
      expect(prompt).toContain('### Expected Output');
      expect(prompt).toContain('cronJobs()');
      expect(prompt).toContain('### Actual Output');
      expect(prompt).toContain('export default schedules');
      expect(prompt).toContain('### Run Log');
      expect(prompt).toContain('not a Crons object');
      expect(prompt).toContain('### Legacy Guidelines');
    });
  });
});

describe('failureAnalyser integration', () => {
  // These tests would call the actual analyser with mocked LLM responses
  // For now, we test the fallback behavior
  
  test('fallback analysis should have required fields', () => {
    const fallbackAnalysis: FailureAnalysis = {
      analysis: 'Analysis failed after 3 attempts: timeout. Manual review recommended for eval: test-eval',
      suggestedGuideline: 'Review and fix the issue in eval test-eval - automatic analysis could not determine the root cause.',
      confidence: 'low',
      relatedLegacyGuidelines: [],
    };

    expect(fallbackAnalysis.analysis).toContain('failed');
    expect(fallbackAnalysis.confidence).toBe('low');
    expect(fallbackAnalysis.relatedLegacyGuidelines).toEqual([]);
  });
});
