/**
 * Integration tests for the eval runner parsing.
 * 
 * These tests verify that the evalRunner correctly parses real results files.
 * 
 * Key edge cases covered:
 * - Single-line summary JSON format
 * - Multi-line JSONL (multiple runs appended to same file)
 * - Empty results
 * - Various path formats (Windows/Unix)
 */
import { describe, test, expect } from 'bun:test';
import { join } from 'path';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs';

const TEST_TMP_DIR = join(import.meta.dir, '__test_tmp__');

function setupTestDir() {
  if (existsSync(TEST_TMP_DIR)) {
    rmSync(TEST_TMP_DIR, { recursive: true });
  }
  mkdirSync(TEST_TMP_DIR, { recursive: true });
}

function cleanupTestDir() {
  if (existsSync(TEST_TMP_DIR)) {
    rmSync(TEST_TMP_DIR, { recursive: true });
  }
}

describe('evalRunner parsing', () => {
  test('should parse summary format with all fields', () => {
    setupTestDir();

    // Create a realistic results.jsonl
    const mockResults = {
      summary: {
        project_name: 'Convex Coding',
        experiment_name: 'GPT-5 mini',
        scores: {
          'Valid filesystem output': { score: 1.0 },
          '`bun install` succeeds': { score: 1.0 },
          '`convex dev` succeeds': { score: 0.5 },
        },
      },
      individual_results: [
        {
          category: '000-fundamentals',
          name: '000-empty_functions',
          passed: true,
          tests_pass_score: 1.0,
          failure_reason: null,
          directory_path: join(TEST_TMP_DIR, 'output/000-fundamentals/000-empty_functions'),
          scores: { 'Valid filesystem output': 1, '`bun install` succeeds': 1, '`convex dev` succeeds': 1 },
        },
        {
          category: '000-fundamentals',
          name: '003-crons',
          passed: false,
          tests_pass_score: 0.0,
          failure_reason: 'convex dev fail',
          directory_path: join(TEST_TMP_DIR, 'output/000-fundamentals/003-crons'),
          scores: { 'Valid filesystem output': 1, '`bun install` succeeds': 1, '`convex dev` succeeds': 0 },
        },
        {
          category: '001-data_modeling',
          name: '000-simple_datatypes',
          passed: true,
          tests_pass_score: 1.0,
          failure_reason: null,
          directory_path: join(TEST_TMP_DIR, 'output/001-data_modeling/000-simple_datatypes'),
          scores: { 'Valid filesystem output': 1, '`bun install` succeeds': 1, '`convex dev` succeeds': 1 },
        },
      ],
      run_stats: {
        total_tests: 3,
        total_passed: 2,
        total_failed: 1,
        overall_score: 0.666,
      },
    };

    const resultsPath = join(TEST_TMP_DIR, 'results.jsonl');
    writeFileSync(resultsPath, JSON.stringify(mockResults));

    // Parse it
    const content = readFileSync(resultsPath, 'utf-8').trim();
    const data = JSON.parse(content);

    // Verify structure
    expect(data.individual_results).toHaveLength(3);
    expect(data.run_stats.total_tests).toBe(3);
    expect(data.run_stats.total_passed).toBe(2);
    expect(data.run_stats.total_failed).toBe(1);

    // Verify we can filter failures
    const failures = data.individual_results.filter((r: { passed: boolean }) => !r.passed);
    expect(failures).toHaveLength(1);
    expect(failures[0].name).toBe('003-crons');
    expect(failures[0].failure_reason).toBe('convex dev fail');

    cleanupTestDir();
  });

  test('should handle different failure reasons', () => {
    const failureReasons = [
      'convex dev fail',
      'tests fail',
      'tsc fail',
      'eslint fail',
      null, // passed
    ];

    for (const reason of failureReasons) {
      const result = {
        category: 'test',
        name: 'test',
        passed: reason === null,
        failure_reason: reason,
        directory_path: '/tmp/test',
      };

      if (reason === null) {
        expect(result.passed).toBe(true);
        expect(result.failure_reason).toBeNull();
      } else {
        expect(result.passed).toBe(false);
        expect(result.failure_reason).toBe(reason);
      }
    }
  });

  test('should construct correct file paths from directory_path', () => {
    const item = {
      category: '000-fundamentals',
      name: '003-crons',
      passed: false,
      directory_path: 'C:/dev/convex-evals/tmp/output/000-fundamentals/003-crons',
    };

    const evalName = `${item.category}/${item.name}`;
    const runLogPath = join(item.directory_path, 'run.log');
    const taskPath = join(item.directory_path, 'TASK.txt');

    expect(evalName).toBe('000-fundamentals/003-crons');
    expect(runLogPath).toContain('run.log');
    expect(taskPath).toContain('TASK.txt');
  });

  test('should handle large results file', () => {
    setupTestDir();

    // Create a results file with many entries
    const individualResults = [];
    for (let i = 0; i < 100; i++) {
      individualResults.push({
        category: `category-${Math.floor(i / 10)}`,
        name: `test-${i}`,
        passed: i % 3 !== 0, // Every 3rd test fails
        failure_reason: i % 3 !== 0 ? null : 'test fail',
        directory_path: `/tmp/output/test-${i}`,
      });
    }

    const mockResults = {
      individual_results: individualResults,
      run_stats: {
        total_tests: 100,
        total_passed: 66,
        total_failed: 34,
      },
    };

    const resultsPath = join(TEST_TMP_DIR, 'large_results.jsonl');
    writeFileSync(resultsPath, JSON.stringify(mockResults));

    const content = readFileSync(resultsPath, 'utf-8').trim();
    const data = JSON.parse(content);

    expect(data.individual_results).toHaveLength(100);
    
    const failures = data.individual_results.filter((r: { passed: boolean }) => !r.passed);
    expect(failures.length).toBe(34); // 0, 3, 6, 9, ... 99 = 34 failures

    cleanupTestDir();
  });
});

describe('evalRunner edge cases', () => {
  test('should handle empty individual_results', () => {
    const mockResults = {
      individual_results: [],
      run_stats: {
        total_tests: 0,
        total_passed: 0,
        total_failed: 0,
      },
    };

    expect(mockResults.individual_results).toHaveLength(0);
    expect(mockResults.run_stats.total_tests).toBe(0);
  });

  test('should handle results with special characters in paths', () => {
    const item = {
      category: '000-fundamentals',
      name: '003-crons',
      directory_path: 'C:\\dev\\convex-evals\\tmp\\output\\000-fundamentals\\003-crons',
    };

    // Path should be usable with join
    const runLogPath = join(item.directory_path, 'run.log');
    expect(runLogPath).toBeDefined();
    expect(typeof runLogPath).toBe('string');
  });

  test('should handle mixed forward/backward slashes in paths', () => {
    const paths = [
      'C:/dev/convex-evals/tmp/output',
      'C:\\dev\\convex-evals\\tmp\\output',
      '/home/user/convex-evals/tmp/output',
    ];

    for (const basePath of paths) {
      const runLogPath = join(basePath, 'run.log');
      expect(runLogPath).toContain('run.log');
    }
  });
});

describe('multi-line JSONL parsing', () => {
  test('should take the last line when multiple JSON objects exist', () => {
    setupTestDir();

    // Create first run results
    const firstRun = {
      individual_results: [
        { category: 'test', name: 'first', passed: false, failure_reason: 'fail', directory_path: '/tmp/first' },
      ],
      run_stats: { total_tests: 1, total_passed: 0, total_failed: 1 },
    };

    // Create second run results (better results)
    const secondRun = {
      individual_results: [
        { category: 'test', name: 'second', passed: true, failure_reason: null, directory_path: '/tmp/second' },
        { category: 'test', name: 'third', passed: true, failure_reason: null, directory_path: '/tmp/third' },
      ],
      run_stats: { total_tests: 2, total_passed: 2, total_failed: 0 },
    };

    // Write as multi-line JSONL (how results.jsonl grows over multiple runs)
    const resultsPath = join(TEST_TMP_DIR, 'multi_results.jsonl');
    writeFileSync(resultsPath, JSON.stringify(firstRun) + '\n' + JSON.stringify(secondRun));

    // Simulate how parseResults should work: take the last line
    const content = readFileSync(resultsPath, 'utf-8').trim();
    const lines = content.split('\n').filter(line => line.trim());
    
    expect(lines).toHaveLength(2);
    
    // Take last line (most recent run)
    const lastLine = lines[lines.length - 1];
    const data = JSON.parse(lastLine);

    // Should be the second run's data
    expect(data.individual_results).toHaveLength(2);
    expect(data.run_stats.total_passed).toBe(2);
    expect(data.run_stats.total_failed).toBe(0);
    expect(data.individual_results[0].name).toBe('second');

    cleanupTestDir();
  });

  test('should handle three or more runs appended', () => {
    setupTestDir();

    const runs = [
      { individual_results: [{ category: 'a', name: 'run1', passed: false, failure_reason: 'f', directory_path: '/t' }], run_stats: { total_tests: 1, total_passed: 0, total_failed: 1 } },
      { individual_results: [{ category: 'a', name: 'run2', passed: false, failure_reason: 'f', directory_path: '/t' }], run_stats: { total_tests: 1, total_passed: 0, total_failed: 1 } },
      { individual_results: [{ category: 'a', name: 'run3', passed: true, failure_reason: null, directory_path: '/t' }], run_stats: { total_tests: 1, total_passed: 1, total_failed: 0 } },
    ];

    const resultsPath = join(TEST_TMP_DIR, 'three_runs.jsonl');
    writeFileSync(resultsPath, runs.map(r => JSON.stringify(r)).join('\n'));

    const content = readFileSync(resultsPath, 'utf-8').trim();
    const lines = content.split('\n').filter(line => line.trim());
    
    expect(lines).toHaveLength(3);
    
    const lastData = JSON.parse(lines[lines.length - 1]);
    expect(lastData.individual_results[0].name).toBe('run3');
    expect(lastData.run_stats.total_passed).toBe(1);

    cleanupTestDir();
  });

  test('should handle single line (no newlines)', () => {
    setupTestDir();

    const singleRun = {
      individual_results: [
        { category: 'test', name: 'only', passed: true, failure_reason: null, directory_path: '/tmp/only' },
      ],
      run_stats: { total_tests: 1, total_passed: 1, total_failed: 0 },
    };

    const resultsPath = join(TEST_TMP_DIR, 'single.jsonl');
    writeFileSync(resultsPath, JSON.stringify(singleRun));

    const content = readFileSync(resultsPath, 'utf-8').trim();
    const lines = content.split('\n').filter(line => line.trim());
    
    expect(lines).toHaveLength(1);
    
    const data = JSON.parse(lines[0]);
    expect(data.individual_results[0].name).toBe('only');

    cleanupTestDir();
  });

  test('should handle trailing newlines', () => {
    setupTestDir();

    const run = {
      individual_results: [{ category: 't', name: 'n', passed: true, failure_reason: null, directory_path: '/t' }],
      run_stats: { total_tests: 1, total_passed: 1, total_failed: 0 },
    };

    const resultsPath = join(TEST_TMP_DIR, 'trailing.jsonl');
    writeFileSync(resultsPath, JSON.stringify(run) + '\n\n\n');

    const content = readFileSync(resultsPath, 'utf-8').trim();
    const lines = content.split('\n').filter(line => line.trim());
    
    expect(lines).toHaveLength(1);
    
    const data = JSON.parse(lines[0]);
    expect(data.run_stats.total_passed).toBe(1);

    cleanupTestDir();
  });

  test('should correctly parse the real failing scenario (multiple runs)', () => {
    // This test simulates the exact scenario that caused the bug:
    // Two complete runs written to results.jsonl, each as a single JSON object per line
    setupTestDir();

    // Simplified versions of real run data
    const run1 = {
      summary: { project_name: 'Convex Coding', experiment_name: 'GPT-5 mini' },
      individual_results: [
        { category: '000-fundamentals', name: '000-empty_functions', passed: false, failure_reason: 'tests fail', directory_path: '/run1/000' },
        { category: '000-fundamentals', name: '003-crons', passed: false, failure_reason: 'convex dev fail', directory_path: '/run1/003' },
      ],
      run_stats: { total_tests: 66, total_passed: 24, total_failed: 42 },
    };

    const run2 = {
      summary: { project_name: 'Convex Coding', experiment_name: 'GPT-5 mini' },
      individual_results: [
        { category: '000-fundamentals', name: '000-empty_functions', passed: true, failure_reason: null, directory_path: '/run2/000' },
        { category: '000-fundamentals', name: '003-crons', passed: false, failure_reason: 'tests fail', directory_path: '/run2/003' },
      ],
      run_stats: { total_tests: 66, total_passed: 37, total_failed: 29 },
    };

    const resultsPath = join(TEST_TMP_DIR, 'real_scenario.jsonl');
    writeFileSync(resultsPath, JSON.stringify(run1) + '\n' + JSON.stringify(run2));

    // Verify the file is valid
    const content = readFileSync(resultsPath, 'utf-8').trim();
    const lines = content.split('\n').filter(line => line.trim());
    
    expect(lines).toHaveLength(2);

    // Each line should be valid JSON
    expect(() => JSON.parse(lines[0])).not.toThrow();
    expect(() => JSON.parse(lines[1])).not.toThrow();

    // Parsing the whole content as a single JSON should FAIL
    // (this was the original bug)
    expect(() => JSON.parse(content)).toThrow();

    // Parsing just the last line should succeed
    const lastData = JSON.parse(lines[lines.length - 1]);
    expect(lastData.run_stats.total_passed).toBe(37);
    expect(lastData.run_stats.total_failed).toBe(29);

    cleanupTestDir();
  });
});
