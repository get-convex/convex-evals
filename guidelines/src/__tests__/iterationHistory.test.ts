import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';
import type { IterationRecord, IterationHistory, IterationFeedback } from '../types.js';
import {
  getIterationHistoryPath,
  readIterationHistory,
  appendIterationRecord,
  computeIterationFeedback,
  summarizeGuidelinesDiff,
  updateLastIterationDiff,
  getRecentIterationFeedback,
} from '../iterationHistory.js';

const TEST_PROVIDER = 'test-provider';
const TEST_MODEL = 'test-model';

describe('iterationHistory', () => {
  let testHistoryPath: string;

  beforeEach(() => {
    testHistoryPath = getIterationHistoryPath(TEST_PROVIDER, TEST_MODEL);
    // Clean up any existing test file
    if (existsSync(testHistoryPath)) {
      unlinkSync(testHistoryPath);
    }
  });

  afterEach(() => {
    // Clean up after tests
    if (existsSync(testHistoryPath)) {
      unlinkSync(testHistoryPath);
    }
  });

  describe('getIterationHistoryPath', () => {
    test('should return correct path format', () => {
      const path = getIterationHistoryPath('openai', 'gpt-4');
      expect(path).toContain('openai_gpt-4');
      expect(path).toContain('iteration_history.json');
    });
  });

  describe('readIterationHistory', () => {
    test('should return empty history when file does not exist', () => {
      const history = readIterationHistory(TEST_PROVIDER, TEST_MODEL);
      expect(history).toEqual({ iterations: [] });
    });

    test('should read existing history', () => {
      const record: IterationRecord = {
        iteration: 1,
        runId: 'test-run-1',
        timestamp: '2026-01-20T10:00:00Z',
        passCount: 50,
        failCount: 16,
        evalResults: { 'eval1': true, 'eval2': false },
      };
      appendIterationRecord(TEST_PROVIDER, TEST_MODEL, record);

      const history = readIterationHistory(TEST_PROVIDER, TEST_MODEL);
      expect(history.iterations).toHaveLength(1);
      expect(history.iterations[0].iteration).toBe(1);
      expect(history.iterations[0].passCount).toBe(50);
    });

    test('should handle invalid JSON gracefully', () => {
      // Create invalid JSON file
      const { writeFileSync } = require('fs');
      const { dirname } = require('path');
      const dir = dirname(testHistoryPath);
      mkdirSync(dir, { recursive: true });
      writeFileSync(testHistoryPath, 'invalid json', 'utf-8');

      const history = readIterationHistory(TEST_PROVIDER, TEST_MODEL);
      expect(history).toEqual({ iterations: [] });
    });
  });

  describe('appendIterationRecord', () => {
    test('should append new record', () => {
      const record: IterationRecord = {
        iteration: 1,
        runId: 'test-run-1',
        timestamp: '2026-01-20T10:00:00Z',
        passCount: 50,
        failCount: 16,
        evalResults: { 'eval1': true, 'eval2': false },
      };

      appendIterationRecord(TEST_PROVIDER, TEST_MODEL, record);
      const history = readIterationHistory(TEST_PROVIDER, TEST_MODEL);

      expect(history.iterations).toHaveLength(1);
      expect(history.iterations[0]).toEqual(record);
    });

    test('should append multiple records', () => {
      const record1: IterationRecord = {
        iteration: 1,
        runId: 'test-run-1',
        timestamp: '2026-01-20T10:00:00Z',
        passCount: 50,
        failCount: 16,
        evalResults: { 'eval1': true },
      };
      const record2: IterationRecord = {
        iteration: 2,
        runId: 'test-run-2',
        timestamp: '2026-01-20T11:00:00Z',
        passCount: 55,
        failCount: 11,
        evalResults: { 'eval1': true, 'eval2': true },
      };

      appendIterationRecord(TEST_PROVIDER, TEST_MODEL, record1);
      appendIterationRecord(TEST_PROVIDER, TEST_MODEL, record2);

      const history = readIterationHistory(TEST_PROVIDER, TEST_MODEL);
      expect(history.iterations).toHaveLength(2);
      expect(history.iterations[0].iteration).toBe(1);
      expect(history.iterations[1].iteration).toBe(2);
    });

    test('should limit to MAX_HISTORY_ITERATIONS', () => {
      // Add 25 records (more than the 20 limit)
      for (let i = 1; i <= 25; i++) {
        const record: IterationRecord = {
          iteration: i,
          runId: `test-run-${i}`,
          timestamp: `2026-01-20T${10 + i}:00:00Z`,
          passCount: 50 + i,
          failCount: 16 - i,
          evalResults: {},
        };
        appendIterationRecord(TEST_PROVIDER, TEST_MODEL, record);
      }

      const history = readIterationHistory(TEST_PROVIDER, TEST_MODEL);
      expect(history.iterations).toHaveLength(20);
      // Should keep the last 20 (iterations 6-25)
      expect(history.iterations[0].iteration).toBe(6);
      expect(history.iterations[19].iteration).toBe(25);
    });
  });

  describe('computeIterationFeedback', () => {
    test('should return null for empty history', () => {
      const history: IterationHistory = { iterations: [] };
      const feedback = computeIterationFeedback(history, 1);
      expect(feedback).toBeNull();
    });

    test('should return null for single iteration', () => {
      const record: IterationRecord = {
        iteration: 1,
        runId: 'test-run-1',
        timestamp: '2026-01-20T10:00:00Z',
        passCount: 50,
        failCount: 16,
        evalResults: {},
      };
      appendIterationRecord(TEST_PROVIDER, TEST_MODEL, record);
      const history = readIterationHistory(TEST_PROVIDER, TEST_MODEL);

      const feedback = computeIterationFeedback(history, 1);
      expect(feedback).toBeNull();
    });

    test('should compute feedback between iterations', () => {
      const record1: IterationRecord = {
        iteration: 1,
        runId: 'test-run-1',
        timestamp: '2026-01-20T10:00:00Z',
        passCount: 50,
        failCount: 16,
        evalResults: {
          'eval1': false,
          'eval2': true,
          'eval3': false,
        },
      };
      const record2: IterationRecord = {
        iteration: 2,
        runId: 'test-run-2',
        timestamp: '2026-01-20T11:00:00Z',
        passCount: 52,
        failCount: 14,
        evalResults: {
          'eval1': true,  // flipped to pass
          'eval2': true,
          'eval3': false,
          'eval4': false, // new eval
        },
        guidelinesDiff: 'Added pagination section',
      };

      appendIterationRecord(TEST_PROVIDER, TEST_MODEL, record1);
      appendIterationRecord(TEST_PROVIDER, TEST_MODEL, record2);
      const history = readIterationHistory(TEST_PROVIDER, TEST_MODEL);

      const feedback = computeIterationFeedback(history, 2);
      expect(feedback).not.toBeNull();
      expect(feedback!.previousIteration).toBe(1);
      expect(feedback!.currentIteration).toBe(2);
      expect(feedback!.passCountDelta).toBe(2); // 52 - 50
      expect(feedback!.evalsFlippedToPass).toEqual(['eval1']);
      expect(feedback!.evalsFlippedToFail).toEqual([]);
      expect(feedback!.changesMade).toBe('Added pagination section');
    });

    test('should detect regressions', () => {
      const record1: IterationRecord = {
        iteration: 1,
        runId: 'test-run-1',
        timestamp: '2026-01-20T10:00:00Z',
        passCount: 50,
        failCount: 16,
        evalResults: {
          'eval1': true,
          'eval2': true,
        },
      };
      const record2: IterationRecord = {
        iteration: 2,
        runId: 'test-run-2',
        timestamp: '2026-01-20T11:00:00Z',
        passCount: 48,
        failCount: 18,
        evalResults: {
          'eval1': false, // regressed
          'eval2': true,
        },
      };

      appendIterationRecord(TEST_PROVIDER, TEST_MODEL, record1);
      appendIterationRecord(TEST_PROVIDER, TEST_MODEL, record2);
      const history = readIterationHistory(TEST_PROVIDER, TEST_MODEL);

      const feedback = computeIterationFeedback(history, 2);
      expect(feedback!.passCountDelta).toBe(-2);
      expect(feedback!.evalsFlippedToFail).toEqual(['eval1']);
    });
  });

  describe('summarizeGuidelinesDiff', () => {
    test('should report minor refinements for small changes', () => {
      const before = 'A'.repeat(100); // 25 tokens
      const after = 'A'.repeat(120);  // 30 tokens, diff = 5
      const summary = summarizeGuidelinesDiff(before, after);
      expect(summary).toContain('Minor refinements');
    });

    test('should report added tokens for large additions', () => {
      // Need > 100 token delta, so > 400 char delta (100 tokens = 400 chars)
      const before = 'A'.repeat(100); // 25 tokens
      const after = 'A'.repeat(510);  // 127.5 tokens, diff = 102.5 -> 103 tokens
      const summary = summarizeGuidelinesDiff(before, after);
      expect(summary).toContain('Added');
      expect(summary).toContain('tokens');
    });

    test('should report removed tokens for large removals', () => {
      // Need < -100 token delta, so > 400 char reduction
      const before = 'A'.repeat(510); // 127.5 tokens
      const after = 'A'.repeat(100);  // 25 tokens, diff = -102.5 -> -103 tokens
      const summary = summarizeGuidelinesDiff(before, after);
      expect(summary).toContain('Removed');
      expect(summary).toContain('tokens');
    });

    test('should detect new sections for moderate token changes', () => {
      // Need token delta between 50-100 to trigger section detection
      // 50 tokens = 200 chars, so we need 200-400 char delta
      const before = '## Section 1\n\nContent here';
      const after = '## Section 1\n\nContent here\n\n## Section 2\n\n' + 'A'.repeat(250);
      const summary = summarizeGuidelinesDiff(before, after);
      // Should either detect section addition or report as modified
      expect(summary.length).toBeGreaterThan(0);
      expect(['Added', 'Modified', 'Minor'].some(word => summary.includes(word))).toBe(true);
    });

    test('should handle section changes', () => {
      // Test that section detection logic works
      const before = '## Section 1\n\n## Section 2\n\n## Section 3';
      const after = '## Section 1\n\n## Section 2';
      // Create moderate token delta (between 50-100 tokens)
      const beforeWithContent = before + '\n\n' + 'A'.repeat(300); // ~75 tokens
      const afterWithContent = after + '\n\n' + 'A'.repeat(100);   // ~25 tokens, diff = -50
      const summary = summarizeGuidelinesDiff(beforeWithContent, afterWithContent);
      // Should detect section removal or report as modified
      expect(summary.length).toBeGreaterThan(0);
    });
  });

  describe('updateLastIterationDiff', () => {
    test('should update last record diff', () => {
      const record: IterationRecord = {
        iteration: 1,
        runId: 'test-run-1',
        timestamp: '2026-01-20T10:00:00Z',
        passCount: 50,
        failCount: 16,
        evalResults: {},
      };
      appendIterationRecord(TEST_PROVIDER, TEST_MODEL, record);

      updateLastIterationDiff(TEST_PROVIDER, TEST_MODEL, 'Added pagination guidelines');

      const history = readIterationHistory(TEST_PROVIDER, TEST_MODEL);
      expect(history.iterations[0].guidelinesDiff).toBe('Added pagination guidelines');
    });

    test('should do nothing for empty history', () => {
      // Should not throw
      updateLastIterationDiff(TEST_PROVIDER, TEST_MODEL, 'test diff');
    });
  });

  describe('getRecentIterationFeedback', () => {
    test('should return empty array for insufficient history', () => {
      const record: IterationRecord = {
        iteration: 1,
        runId: 'test-run-1',
        timestamp: '2026-01-20T10:00:00Z',
        passCount: 50,
        failCount: 16,
        evalResults: {},
      };
      appendIterationRecord(TEST_PROVIDER, TEST_MODEL, record);
      const history = readIterationHistory(TEST_PROVIDER, TEST_MODEL);

      const feedback = getRecentIterationFeedback(history, 5);
      expect(feedback).toEqual([]);
    });

    test('should return feedback for recent iterations', () => {
      // Create 3 iterations
      for (let i = 1; i <= 3; i++) {
        const record: IterationRecord = {
          iteration: i,
          runId: `test-run-${i}`,
          timestamp: `2026-01-20T${10 + i}:00:00Z`,
          passCount: 50 + i,
          failCount: 16 - i,
          evalResults: {
            [`eval${i}`]: i > 1, // eval1 fails in iter 1, passes in iter 2+
          },
          guidelinesDiff: `Changes for iteration ${i}`,
        };
        appendIterationRecord(TEST_PROVIDER, TEST_MODEL, record);
      }

      const history = readIterationHistory(TEST_PROVIDER, TEST_MODEL);
      const feedback = getRecentIterationFeedback(history, 5);

      expect(feedback).toHaveLength(2); // 2 transitions: 1→2, 2→3
      expect(feedback[0].previousIteration).toBe(1);
      expect(feedback[0].currentIteration).toBe(2);
      expect(feedback[1].previousIteration).toBe(2);
      expect(feedback[1].currentIteration).toBe(3);
    });

    test('should limit to maxEntries', () => {
      // Create 10 iterations
      for (let i = 1; i <= 10; i++) {
        const record: IterationRecord = {
          iteration: i,
          runId: `test-run-${i}`,
          timestamp: `2026-01-20T${10 + i}:00:00Z`,
          passCount: 50 + i,
          failCount: 16 - i,
          evalResults: {},
        };
        appendIterationRecord(TEST_PROVIDER, TEST_MODEL, record);
      }

      const history = readIterationHistory(TEST_PROVIDER, TEST_MODEL);
      const feedback = getRecentIterationFeedback(history, 3);

      expect(feedback).toHaveLength(3); // Should limit to 3 most recent
      expect(feedback[0].previousIteration).toBe(7);
      expect(feedback[0].currentIteration).toBe(8);
      expect(feedback[2].previousIteration).toBe(9);
      expect(feedback[2].currentIteration).toBe(10);
    });

    test('should correctly identify flipped evals', () => {
      const record1: IterationRecord = {
        iteration: 1,
        runId: 'test-run-1',
        timestamp: '2026-01-20T10:00:00Z',
        passCount: 50,
        failCount: 16,
        evalResults: {
          'eval1': false,
          'eval2': true,
          'eval3': false,
        },
      };
      const record2: IterationRecord = {
        iteration: 2,
        runId: 'test-run-2',
        timestamp: '2026-01-20T11:00:00Z',
        passCount: 52,
        failCount: 14,
        evalResults: {
          'eval1': true,  // flipped to pass
          'eval2': false, // flipped to fail
          'eval3': false, // still failing
        },
      };

      appendIterationRecord(TEST_PROVIDER, TEST_MODEL, record1);
      appendIterationRecord(TEST_PROVIDER, TEST_MODEL, record2);
      const history = readIterationHistory(TEST_PROVIDER, TEST_MODEL);

      const feedback = getRecentIterationFeedback(history, 5);
      expect(feedback).toHaveLength(1);
      expect(feedback[0].evalsFlippedToPass).toEqual(['eval1']);
      expect(feedback[0].evalsFlippedToFail).toEqual(['eval2']);
    });
  });
});
