import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, copyFileSync } from 'fs';
import { join } from 'path';

// Import the exported functions from tools.ts
import {
  toGitBashPath,
  parseResultsSummary,
  classifyErrorPattern,
  createOrchestratorTools,
} from './tools';

// Test fixtures directory
const TEST_DIR = join(import.meta.dir, '..', 'tmp', '_test_fixtures');
const TEST_OUTPUT_DIR = join(TEST_DIR, 'eval_output');
const TEST_RESULTS_PATH = join(TEST_DIR, 'results.jsonl');
const TEST_WORKSPACE_ROOT = join(import.meta.dir, '..', '..');
const TEST_MODEL_NAME = 'test-model';

// Sample results data matching the real format
function createTestResultsData() {
  return {
    individual_results: [
      {
        category: '000-fundamentals',
        name: '000-empty_functions',
        passed: true,
        tests_pass_score: 1.0,
        failure_reason: null,
      },
      {
        category: '000-fundamentals',
        name: '001-basic_schema',
        passed: false,
        tests_pass_score: 0.0,
        failure_reason: 'convex dev fail',
      },
      {
        category: '002-queries',
        name: '009-text_search',
        passed: false,
        tests_pass_score: 0.0,
        failure_reason: 'convex dev fail',
      },
      {
        category: '004-actions',
        name: '000-fetch',
        passed: false,
        tests_pass_score: 0.0,
        failure_reason: 'convex dev fail',
      },
    ],
  };
}

// Alternative format with evalName field
function createTestResultsDataWithEvalName() {
  return {
    passed: 1,
    failed: 3,
    total: 4,
    results: [
      { evalName: '000-fundamentals/000-empty_functions', passed: true },
      { evalName: '000-fundamentals/001-basic_schema', passed: false },
      { evalName: '002-queries/009-text_search', passed: false },
      { evalName: '004-actions/000-fetch', passed: false },
    ],
  };
}

describe('toGitBashPath', () => {
  test('converts Windows drive path to Git Bash format', () => {
    expect(toGitBashPath('C:\\dev\\convex')).toBe('/c/dev/convex');
    expect(toGitBashPath('D:\\Users\\test')).toBe('/d/Users/test');
  });

  test('handles lowercase drive letters', () => {
    expect(toGitBashPath('c:\\dev\\convex')).toBe('/c/dev/convex');
  });

  test('handles paths with forward slashes', () => {
    expect(toGitBashPath('C:/dev/convex')).toBe('/c/dev/convex');
  });

  test('handles mixed slashes', () => {
    expect(toGitBashPath('C:\\dev/convex\\test')).toBe('/c/dev/convex/test');
  });

  test('handles paths without drive letters', () => {
    expect(toGitBashPath('/usr/local/bin')).toBe('/usr/local/bin');
  });
});

describe('parseResultsSummary', () => {
  beforeAll(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterAll(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  test('returns null for non-existent file', () => {
    const result = parseResultsSummary('/nonexistent/path/results.jsonl');
    expect(result).toBeNull();
  });

  test('parses individual_results format correctly', () => {
    const data = createTestResultsData();
    writeFileSync(TEST_RESULTS_PATH, JSON.stringify(data) + '\n');

    const result = parseResultsSummary(TEST_RESULTS_PATH);
    expect(result).not.toBeNull();
    expect(result!.passed).toBe(1);
    expect(result!.failed).toBe(3);
    expect(result!.total).toBe(4);
    expect(result!.failures).toHaveLength(3);
    expect(result!.failures).toContain('000-fundamentals/001-basic_schema');
    expect(result!.failures).toContain('002-queries/009-text_search');
    expect(result!.failures).toContain('004-actions/000-fetch');
  });

  test('parses results format with evalName correctly', () => {
    const data = createTestResultsDataWithEvalName();
    writeFileSync(TEST_RESULTS_PATH, JSON.stringify(data) + '\n');

    const result = parseResultsSummary(TEST_RESULTS_PATH);
    expect(result).not.toBeNull();
    expect(result!.passed).toBe(1);
    expect(result!.failed).toBe(3);
    expect(result!.total).toBe(4);
    expect(result!.failures).toContain('000-fundamentals/001-basic_schema');
  });

  test('handles invalid JSON gracefully', () => {
    writeFileSync(TEST_RESULTS_PATH, 'not valid json\n');
    const result = parseResultsSummary(TEST_RESULTS_PATH);
    expect(result).toBeNull();
  });

  test('reads last line for multi-line files', () => {
    const data1 = { individual_results: [{ category: 'test', name: 'old', passed: true }] };
    const data2 = createTestResultsData();
    writeFileSync(TEST_RESULTS_PATH, JSON.stringify(data1) + '\n' + JSON.stringify(data2) + '\n');

    const result = parseResultsSummary(TEST_RESULTS_PATH);
    expect(result).not.toBeNull();
    expect(result!.total).toBe(4); // Should read the last line (data2)
  });
});

describe('classifyErrorPattern', () => {
  test('identifies v.json pattern', () => {
    const errorLines = 'Error: v.json is not a function\nFailed to analyze';
    expect(classifyErrorPattern(errorLines)).toBe('v.json() does not exist');
  });

  test('identifies i.json pattern (minified)', () => {
    const errorLines = 'TypeError: i.json is not a function';
    expect(classifyErrorPattern(errorLines)).toBe('v.json() does not exist');
  });

  test('identifies v.dict pattern', () => {
    const errorLines = 'Error: v.dict is not a function';
    expect(classifyErrorPattern(errorLines)).toBe('v.dict() does not exist');
  });

  test('identifies "use node" mutation pattern', () => {
    const errorLines = 'saveFetchResult defined in index.js is a Mutation function. "use node"';
    expect(classifyErrorPattern(errorLines)).toBe('mutations in "use node" file');
  });

  test('identifies "use node" not allowed pattern', () => {
    const errorLines = '"use node" directive is not allowed';
    expect(classifyErrorPattern(errorLines)).toBe('"use node" not allowed');
  });

  test('identifies pagination pattern', () => {
    const errorLines = "Object contains extra field 'pageStatus'";
    expect(classifyErrorPattern(errorLines)).toBe('pagination returns validator incomplete');
  });

  test('identifies splitCursor pattern', () => {
    const errorLines = 'splitCursor is not defined';
    expect(classifyErrorPattern(errorLines)).toBe('pagination returns validator incomplete');
  });

  test('identifies text search pattern', () => {
    const errorLines = "Property '.search' does not exist on type 'GenericDatabaseReader'";
    expect(classifyErrorPattern(errorLines)).toBe('wrong text search API');
  });

  test('identifies range query pattern', () => {
    const errorLines = 'Cannot read property .range of undefined';
    expect(classifyErrorPattern(errorLines)).toBe('wrong index range API');
  });

  test('identifies nullable return pattern', () => {
    const errorLines = "Type 'null' is not assignable to type 'string'";
    expect(classifyErrorPattern(errorLines)).toBe('nullable return type not handled');
  });

  test('returns first line for unknown patterns', () => {
    const errorLines = 'Some completely new error type\nSecond line';
    expect(classifyErrorPattern(errorLines)).toBe('Some completely new error type');
  });

  test('returns unknown for empty error lines', () => {
    expect(classifyErrorPattern('')).toBe('unknown');
    expect(classifyErrorPattern('   ')).toBe('unknown');
  });
});

describe('MCP Tools Integration', () => {
  beforeAll(() => {
    // Create test directory structure
    mkdirSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_OUTPUT_DIR, { recursive: true });

    // Create results.jsonl with properly formatted data
    const resultsData = createTestResultsDataWithEvalName();
    writeFileSync(TEST_RESULTS_PATH, JSON.stringify(resultsData) + '\n');

    // Create run.log files with different error patterns
    const runLogDirs = [
      {
        path: join(TEST_OUTPUT_DIR, 'output', TEST_MODEL_NAME, '000-fundamentals', '001-basic_schema'),
        content: `Starting eval...
Error: v.json is not a function
    at Module._compile (internal/modules/cjs/loader.js:1085:14)
Failed to analyze index.js`,
      },
      {
        path: join(TEST_OUTPUT_DIR, 'output', TEST_MODEL_NAME, '002-queries', '009-text_search'),
        content: `Starting eval...
TypeScript error: Property 'search' does not exist on type 'GenericDatabaseReader'
Build failed with 1 error`,
      },
      {
        path: join(TEST_OUTPUT_DIR, 'output', TEST_MODEL_NAME, '004-actions', '000-fetch'),
        content: `Starting eval...
Error: v.json is not a function
    at Object.<anonymous> (convex/index.ts:5:23)
Build failed`,
      },
    ];

    for (const { path, content } of runLogDirs) {
      mkdirSync(path, { recursive: true });
      writeFileSync(join(path, 'run.log'), content);
    }

    // Create passing eval directory (no run.log needed for passing)
    mkdirSync(
      join(TEST_OUTPUT_DIR, 'output', TEST_MODEL_NAME, '000-fundamentals', '000-empty_functions'),
      { recursive: true }
    );
  });

  afterAll(() => {
    // Clean up test fixtures
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  test('createOrchestratorTools creates a valid MCP server object', () => {
    // The MCP server is an opaque object - we just verify it's created without error
    const server = createOrchestratorTools(TEST_WORKSPACE_ROOT, TEST_OUTPUT_DIR, TEST_RESULTS_PATH, TEST_MODEL_NAME);
    expect(server).toBeDefined();
    // The returned object is McpSdkServerConfigWithInstance which is used by the SDK
  });

  // Test the underlying logic functions that power the tools
  describe('Tool logic via exported functions', () => {
    test('parseResultsSummary correctly extracts summary from test data', () => {
      const result = parseResultsSummary(TEST_RESULTS_PATH);
      expect(result).not.toBeNull();
      expect(result!.passed).toBe(1);
      expect(result!.failed).toBe(3);
      expect(result!.total).toBe(4);
      expect(result!.failures).toContain('000-fundamentals/001-basic_schema');
      expect(result!.failures).toContain('002-queries/009-text_search');
      expect(result!.failures).toContain('004-actions/000-fetch');
    });

    test('classifyErrorPattern correctly identifies patterns in test run.log files', () => {
      // Read the test run.log and verify classification
      const basicSchemaLog = readFileSync(
        join(TEST_OUTPUT_DIR, 'output', TEST_MODEL_NAME, '000-fundamentals', '001-basic_schema', 'run.log'),
        'utf-8'
      );
      expect(classifyErrorPattern(basicSchemaLog)).toBe('v.json() does not exist');

      const textSearchLog = readFileSync(
        join(TEST_OUTPUT_DIR, 'output', TEST_MODEL_NAME, '002-queries', '009-text_search', 'run.log'),
        'utf-8'
      );
      // The pattern detection looks for 'search' and 'does not exist' together
      expect(classifyErrorPattern(textSearchLog)).toBe('wrong text search API');
    });
  });

  // Test checkpoint operations using copyFileSync directly (same logic as tools)
  describe('Checkpoint operations', () => {
    const checkpointTestDir = join(TEST_DIR, 'checkpoint_test');
    const workingPath = join(checkpointTestDir, 'working.txt');
    const checkpointPath = join(checkpointTestDir, 'checkpoint.txt');

    beforeAll(() => {
      mkdirSync(checkpointTestDir, { recursive: true });
      writeFileSync(workingPath, 'working content v1');
    });

    test('copyFileSync can save checkpoint', () => {
      copyFileSync(workingPath, checkpointPath);
      expect(existsSync(checkpointPath)).toBe(true);
      expect(readFileSync(checkpointPath, 'utf-8')).toBe('working content v1');
    });

    test('copyFileSync can revert to checkpoint', () => {
      // First modify the working file
      writeFileSync(workingPath, 'working content v2 - modified');
      expect(readFileSync(workingPath, 'utf-8')).toBe('working content v2 - modified');

      // Revert
      copyFileSync(checkpointPath, workingPath);
      expect(readFileSync(workingPath, 'utf-8')).toBe('working content v1');
    });
  });
});
