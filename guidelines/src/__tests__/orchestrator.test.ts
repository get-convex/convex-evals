import { describe, test, expect } from 'bun:test';
import type { FailureAnalysis } from '../types.js';

describe('orchestrator helpers', () => {
  describe('runWithConcurrencyLimit', () => {
    // Test the concurrency limiter logic
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

    test('should process all items', async () => {
      const items = [1, 2, 3, 4, 5];
      const results = await runWithConcurrencyLimit(
        items,
        async (n) => n * 2,
        2
      );

      expect(results).toEqual([2, 4, 6, 8, 10]);
    });

    test('should respect max concurrency', async () => {
      let maxConcurrent = 0;
      let currentConcurrent = 0;

      const items = [1, 2, 3, 4, 5, 6, 7, 8];
      await runWithConcurrencyLimit(
        items,
        async (n) => {
          currentConcurrent++;
          maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
          await new Promise(resolve => setTimeout(resolve, 10));
          currentConcurrent--;
          return n;
        },
        3
      );

      expect(maxConcurrent).toBeLessThanOrEqual(3);
    });

    test('should call onStart for each item', async () => {
      const started: number[] = [];
      const items = [1, 2, 3];

      await runWithConcurrencyLimit(
        items,
        async (n) => n,
        2,
        (item, index) => {
          started.push(index);
        }
      );

      expect(started.sort()).toEqual([0, 1, 2]);
    });

    test('should handle empty array', async () => {
      const results = await runWithConcurrencyLimit(
        [],
        async (n: number) => n * 2,
        5
      );

      expect(results).toEqual([]);
    });

    test('should handle single item', async () => {
      const results = await runWithConcurrencyLimit(
        [42],
        async (n) => n * 2,
        5
      );

      expect(results).toEqual([84]);
    });

    test('should preserve order even with variable timing', async () => {
      const items = [5, 1, 3, 2, 4]; // Variable delays
      const results = await runWithConcurrencyLimit(
        items,
        async (delay) => {
          await new Promise(resolve => setTimeout(resolve, delay));
          return delay;
        },
        3
      );

      expect(results).toEqual([5, 1, 3, 2, 4]); // Same order as input
    });
  });

  describe('countTokens', () => {
    // Simple heuristic: ~4 chars per token
    function countTokens(text: string): number {
      return Math.ceil(text.length / 4);
    }

    test('should count tokens for short text', () => {
      expect(countTokens('hello')).toBe(2); // 5 chars / 4 = 1.25 -> 2
    });

    test('should count tokens for longer text', () => {
      const text = 'This is a longer piece of text that should have more tokens.';
      // 61 chars / 4 = 15.25 -> ceil = 16, but Math.ceil might round differently
      expect(countTokens(text)).toBeGreaterThan(10);
      expect(countTokens(text)).toBeLessThan(20);
    });

    test('should handle empty text', () => {
      expect(countTokens('')).toBe(0);
    });
  });

  describe('generateRunId', () => {
    function generateRunId(): string {
      const now = new Date();
      const date = now.toISOString().slice(0, 10);
      const time = now.toTimeString().slice(0, 8).replace(/:/g, '-');
      const random = Math.random().toString(16).slice(2, 6);
      return `${date}_${time}_${random}`;
    }

    test('should generate sortable run ID', () => {
      const id1 = generateRunId();
      
      // Format: YYYY-MM-DD_HH-mm-ss_xxxx
      expect(id1).toMatch(/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_[a-f0-9]{4}$/);
    });

    test('should generate mostly unique IDs', () => {
      const ids = new Set<string>();
      for (let i = 0; i < 10; i++) {
        ids.add(generateRunId());
      }
      // Should have mostly unique IDs (random component helps)
      // With only 10 iterations, collisions are very unlikely
      expect(ids.size).toBeGreaterThanOrEqual(9);
    });

    test('should sort alphabetically by date', () => {
      // Manually construct IDs to test sorting
      const ids = [
        '2026-01-20_14-30-00_abcd',
        '2026-01-19_14-30-00_abcd',
        '2026-01-20_13-30-00_abcd',
        '2026-02-20_14-30-00_abcd',
      ];

      const sorted = [...ids].sort();
      expect(sorted).toEqual([
        '2026-01-19_14-30-00_abcd',
        '2026-01-20_13-30-00_abcd',
        '2026-01-20_14-30-00_abcd',
        '2026-02-20_14-30-00_abcd',
      ]);
    });
  });

  describe('summarizeProposalDiff', () => {
    function countTokens(text: string): number {
      return Math.ceil(text.length / 4);
    }

    function summarizeProposalDiff(original: string, proposal: string): string {
      const originalTokens = countTokens(original);
      const proposalTokens = countTokens(proposal);
      const diff = originalTokens - proposalTokens;

      if (diff > 50) return `Removed ~${diff} tokens (too aggressive)`;
      if (diff < 0) return `Added ${-diff} tokens (made it longer)`;
      return `Changed ~${Math.abs(diff)} tokens (subtle change that broke evals)`;
    }

    test('should report removed tokens when diff > 50', () => {
      // Need diff > 50 tokens, so need 200+ char difference
      const original = 'A'.repeat(400); // 100 tokens
      const proposal = 'A'.repeat(100); // 25 tokens, diff = 75
      const summary = summarizeProposalDiff(original, proposal);
      expect(summary).toContain('Removed');
      expect(summary).toContain('too aggressive');
    });

    test('should report added tokens when proposal is longer', () => {
      const original = 'A'.repeat(100); // 25 tokens
      const proposal = 'A'.repeat(200); // 50 tokens, diff = -25
      const summary = summarizeProposalDiff(original, proposal);
      expect(summary).toContain('Added');
      expect(summary).toContain('made it longer');
    });

    test('should report subtle changes for small diffs', () => {
      const original = 'A'.repeat(100); // 25 tokens
      const proposal = 'A'.repeat(80);  // 20 tokens, diff = 5 (between 0 and 50)
      const summary = summarizeProposalDiff(original, proposal);
      expect(summary).toContain('Changed');
      expect(summary).toContain('subtle change');
    });
  });

  describe('iteration history integration', () => {
    test('should create iteration record structure', () => {
      const evalResults = {
        '000-fundamentals/003-crons': false,
        '000-fundamentals/008-helper_fns': true,
        '002-queries/015-pagination': false,
      };

      const record = {
        iteration: 1,
        runId: 'test-run-1',
        timestamp: '2026-01-20T10:00:00Z',
        passCount: 1,
        failCount: 2,
        evalResults,
      };

      expect(record.iteration).toBe(1);
      expect(Object.keys(record.evalResults).length).toBe(3);
      expect(record.passCount + record.failCount).toBe(3);
    });

    test('should map eval results to iteration record', () => {
      const evalResults: Record<string, boolean> = {};
      const mockEvalResults = [
        { evalName: 'eval1', passed: true },
        { evalName: 'eval2', passed: false },
        { evalName: 'eval3', passed: true },
      ];

      for (const result of mockEvalResults) {
        evalResults[result.evalName] = result.passed;
      }

      expect(evalResults['eval1']).toBe(true);
      expect(evalResults['eval2']).toBe(false);
      expect(evalResults['eval3']).toBe(true);
    });

    test('should prepare analyses with eval names for incorporator', () => {
      const failedEvals = [
        { evalName: '002-queries/015-pagination', passed: false },
        { evalName: '000-fundamentals/008-helper_fns', passed: false },
      ];

      const analyses: FailureAnalysis[] = [
        {
          analysis: 'Pagination error',
          suggestedGuideline: 'Use .paginate()',
          confidence: 'high',
          relatedLegacyGuidelines: [],
        },
        {
          analysis: 'Import error',
          suggestedGuideline: 'Import from correct location',
          confidence: 'high',
          relatedLegacyGuidelines: [],
        },
      ];

      const analysesWithEvalNames = failedEvals.map((evalItem, idx) => ({
        evalName: evalItem.evalName,
        analysis: analyses[idx],
      }));

      expect(analysesWithEvalNames.length).toBe(2);
      expect(analysesWithEvalNames[0].evalName).toBe('002-queries/015-pagination');
      expect(analysesWithEvalNames[0].analysis.confidence).toBe('high');
      expect(analysesWithEvalNames[1].evalName).toBe('000-fundamentals/008-helper_fns');
    });

    test('should filter low confidence analyses', () => {
      const analyses: FailureAnalysis[] = [
        {
          analysis: 'High confidence issue',
          suggestedGuideline: 'Fix it',
          confidence: 'high',
          relatedLegacyGuidelines: [],
        },
        {
          analysis: 'Medium confidence issue',
          suggestedGuideline: 'Maybe fix it',
          confidence: 'medium',
          relatedLegacyGuidelines: [],
        },
        {
          analysis: 'Low confidence issue',
          suggestedGuideline: 'Uncertain fix',
          confidence: 'low',
          relatedLegacyGuidelines: [],
        },
      ];

      const goodAnalyses = analyses.filter(a => a.confidence !== 'low');
      expect(goodAnalyses.length).toBe(2);
      expect(goodAnalyses.every(a => a.confidence !== 'low')).toBe(true);
    });
  });
});
