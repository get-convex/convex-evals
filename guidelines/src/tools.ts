import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { readFileSync, existsSync, copyFileSync } from 'fs';
import { join } from 'path';

/**
 * Legacy guidelines extracted from runner/models/guidelines.py
 * These are the reference guidelines used in the original eval system.
 */
const LEGACY_GUIDELINES: Array<{ section: string; guideline: string }> = [
  // Function Guidelines - New Function Syntax
  {
    section: 'function_guidelines/new_function_syntax',
    guideline: `ALWAYS use the new function syntax for Convex functions. For example:
\`\`\`typescript
import { query } from "./_generated/server";
import { v } from "convex/values";
export const f = query({
    args: {},
    returns: v.null(),
    handler: async (ctx, args) => {
    // Function body
    },
});
\`\`\``,
  },
  // HTTP Endpoint Syntax
  {
    section: 'function_guidelines/http_endpoint_syntax',
    guideline: `HTTP endpoints are defined in \`convex/http.ts\` and require an \`httpAction\` decorator. For example:
\`\`\`typescript
import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
const http = httpRouter();
http.route({
    path: "/echo",
    method: "POST",
    handler: httpAction(async (ctx, req) => {
    const body = await req.bytes();
    return new Response(body, { status: 200 });
    }),
});
\`\`\``,
  },
  {
    section: 'function_guidelines/http_endpoint_syntax',
    guideline:
      'HTTP endpoints are always registered at the exact path you specify in the `path` field. For example, if you specify `/api/someRoute`, the endpoint will be registered at `/api/someRoute`.',
  },
  // Validators
  {
    section: 'function_guidelines/validators',
    guideline: `Array validator example:
\`\`\`typescript
import { mutation } from "./_generated/server";
import { v } from "convex/values";
export default mutation({
args: {
    simpleArray: v.array(v.union(v.string(), v.number())),
},
handler: async (ctx, args) => { /* ... */ },
});
\`\`\``,
  },
  {
    section: 'function_guidelines/validators',
    guideline: `Schema with discriminated union type:
\`\`\`typescript
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
export default defineSchema({
    results: defineTable(
        v.union(
            v.object({ kind: v.literal("error"), errorMessage: v.string() }),
            v.object({ kind: v.literal("success"), value: v.number() }),
        ),
    )
});
\`\`\``,
  },
  {
    section: 'function_guidelines/validators',
    guideline:
      'Always use the `v.null()` validator when returning a null value. Include `returns: v.null()` and explicitly `return null;`',
  },
  {
    section: 'function_guidelines/validators',
    guideline: `Valid Convex types and validators:
- Id: v.id(tableName)
- Null: v.null() (JavaScript undefined is not valid, use null instead)
- Int64: v.int64() (for bigint)
- Float64: v.number()
- Boolean: v.boolean()
- String: v.string()
- Bytes: v.bytes() (ArrayBuffer)
- Array: v.array(values)
- Object: v.object({property: value})
- Record: v.record(keys, values)`,
  },
  // Function Registration
  {
    section: 'function_guidelines/function_registration',
    guideline:
      'Use `internalQuery`, `internalMutation`, and `internalAction` for internal functions. These are private and can only be called by other Convex functions. Import from `./_generated/server`.',
  },
  {
    section: 'function_guidelines/function_registration',
    guideline:
      'Use `query`, `mutation`, and `action` for public functions. These are exposed to the public Internet. Do NOT use them for sensitive internal functions.',
  },
  {
    section: 'function_guidelines/function_registration',
    guideline: 'You CANNOT register a function through the `api` or `internal` objects.',
  },
  {
    section: 'function_guidelines/function_registration',
    guideline:
      "ALWAYS include argument and return validators for all Convex functions. If a function doesn't return anything, use `returns: v.null()`.",
  },
  // Function Calling
  {
    section: 'function_guidelines/function_calling',
    guideline: 'Use `ctx.runQuery` to call a query from a query, mutation, or action.',
  },
  {
    section: 'function_guidelines/function_calling',
    guideline: 'Use `ctx.runMutation` to call a mutation from a mutation or action.',
  },
  {
    section: 'function_guidelines/function_calling',
    guideline: 'Use `ctx.runAction` to call an action from an action.',
  },
  {
    section: 'function_guidelines/function_calling',
    guideline:
      'ONLY call an action from another action if you need to cross runtimes (V8 to Node). Otherwise, use a shared helper async function.',
  },
  {
    section: 'function_guidelines/function_calling',
    guideline:
      'Minimize calls from actions to queries/mutations. Queries and mutations are transactions, so splitting logic introduces race condition risks.',
  },
  {
    section: 'function_guidelines/function_calling',
    guideline:
      'ctx.runQuery/runMutation/runAction take a FunctionReference. Do NOT pass the function directly.',
  },
  {
    section: 'function_guidelines/function_calling',
    guideline:
      'When calling a function in the same file with ctx.runQuery/runMutation/runAction, add a type annotation on the return value to work around TypeScript circularity: `const result: string = await ctx.runQuery(api.example.f, { name: "Bob" });`',
  },
  // Function References
  {
    section: 'function_guidelines/function_references',
    guideline: 'Function references are pointers to registered Convex functions.',
  },
  {
    section: 'function_guidelines/function_references',
    guideline:
      'Use the `api` object from `convex/_generated/api.ts` to reference public functions (query, mutation, action).',
  },
  {
    section: 'function_guidelines/function_references',
    guideline:
      'Use the `internal` object from `convex/_generated/api.ts` to reference internal functions (internalQuery, internalMutation, internalAction).',
  },
  {
    section: 'function_guidelines/function_references',
    guideline:
      'Convex uses file-based routing. A function `f` in `convex/example.ts` has reference `api.example.f`. A function in `convex/messages/access.ts` has reference `api.messages.access.h`.',
  },
  // Pagination
  {
    section: 'function_guidelines/pagination',
    guideline:
      'Paginated queries return results in incremental pages using `.paginate(paginationOpts)`.',
  },
  {
    section: 'function_guidelines/pagination',
    guideline: `Pagination syntax:
\`\`\`ts
import { paginationOptsValidator } from "convex/server";
export const list = query({
    args: { paginationOpts: paginationOptsValidator, author: v.string() },
    handler: async (ctx, args) => {
        return await ctx.db.query("messages")
            .filter((q) => q.eq(q.field("author"), args.author))
            .order("desc")
            .paginate(args.paginationOpts);
    },
});
\`\`\`
paginationOpts has: numItems (v.number()) and cursor (v.union(v.string(), v.null()))`,
  },
  {
    section: 'function_guidelines/pagination',
    guideline:
      '.paginate() returns: { page: array of documents, isDone: boolean, continueCursor: string }',
  },
  // Validator Guidelines
  {
    section: 'validator_guidelines',
    guideline: '`v.bigint()` is deprecated. Use `v.int64()` instead for signed 64-bit integers.',
  },
  {
    section: 'validator_guidelines',
    guideline: 'Use `v.record()` for record types. `v.map()` and `v.set()` are NOT supported.',
  },
  // Schema Guidelines
  {
    section: 'schema_guidelines',
    guideline: 'Always define your schema in `convex/schema.ts`.',
  },
  {
    section: 'schema_guidelines',
    guideline: 'Always import schema definition functions from `convex/server`.',
  },
  {
    section: 'schema_guidelines',
    guideline:
      'System fields are automatically added: `_creationTime` (v.number()) and `_id` (v.id(tableName)).',
  },
  {
    section: 'schema_guidelines',
    guideline:
      'Include all index fields in the index name. Example: index on ["field1", "field2"] should be named "by_field1_and_field2".',
  },
  {
    section: 'schema_guidelines',
    guideline:
      'Index fields must be queried in order. To query by field1→field2 AND field2→field1, create separate indexes.',
  },
  // TypeScript Guidelines
  {
    section: 'typescript_guidelines',
    guideline:
      "Use `Id<'tableName'>` from './_generated/dataModel' for document ID types. Example: `Id<'users'>`.",
  },
  {
    section: 'typescript_guidelines',
    guideline:
      "For Record with Id key: `v.record(v.id('users'), v.string())` has type `Record<Id<'users'>, string>`.",
  },
  {
    section: 'typescript_guidelines',
    guideline:
      "Be strict with types. Use `Id<'users'>` instead of `string` for document ID arguments.",
  },
  {
    section: 'typescript_guidelines',
    guideline: 'Use `as const` for string literals in discriminated union types.',
  },
  {
    section: 'typescript_guidelines',
    guideline: 'Define arrays as `const array: Array<T> = [...];`',
  },
  {
    section: 'typescript_guidelines',
    guideline: 'Define records as `const record: Record<KeyType, ValueType> = {...};`',
  },
  // Full Text Search
  {
    section: 'full_text_search_guidelines',
    guideline: `Text search example for "10 messages in #general matching 'hello hi'":
\`\`\`ts
const messages = await ctx.db
  .query("messages")
  .withSearchIndex("search_body", (q) =>
    q.search("body", "hello hi").eq("channel", "#general"),
  )
  .take(10);
\`\`\``,
  },
  // Query Guidelines
  {
    section: 'query_guidelines',
    guideline:
      'Do NOT use `filter` in queries. Define an index in the schema and use `withIndex` instead.',
  },
  {
    section: 'query_guidelines',
    guideline:
      'Convex queries do NOT support `.delete()`. Use `.collect()`, iterate, and call `ctx.db.delete(row._id)` on each.',
  },
  {
    section: 'query_guidelines',
    guideline:
      'Use `.unique()` to get a single document. Throws if multiple documents match.',
  },
  {
    section: 'query_guidelines',
    guideline:
      "For async iteration, don't use `.collect()` or `.take(n)`. Use `for await (const row of query)` syntax.",
  },
  {
    section: 'query_guidelines/ordering',
    guideline: 'Default order is ascending `_creationTime`.',
  },
  {
    section: 'query_guidelines/ordering',
    guideline:
      "Use `.order('asc')` or `.order('desc')` to set order. Default is ascending.",
  },
  {
    section: 'query_guidelines/ordering',
    guideline: 'Queries using indexes are ordered by index columns and avoid table scans.',
  },
  // Mutation Guidelines
  {
    section: 'mutation_guidelines',
    guideline:
      'Use `ctx.db.replace` to fully replace a document. Throws if document does not exist.',
  },
  {
    section: 'mutation_guidelines',
    guideline:
      'Use `ctx.db.patch` to shallow merge updates. Throws if document does not exist.',
  },
  // Action Guidelines
  {
    section: 'action_guidelines',
    guideline: 'Add `"use node";` to the top of files with actions using Node.js built-in modules.',
  },
  {
    section: 'action_guidelines',
    guideline: "Never use `ctx.db` inside an action. Actions don't have database access.",
  },
  // Cron Guidelines
  {
    section: 'scheduling_guidelines/cron_guidelines',
    guideline:
      'Only use `crons.interval` or `crons.cron` methods. Do NOT use `crons.hourly`, `crons.daily`, or `crons.weekly` helpers.',
  },
  {
    section: 'scheduling_guidelines/cron_guidelines',
    guideline: 'Cron methods take a FunctionReference. Do NOT pass the function directly.',
  },
  {
    section: 'scheduling_guidelines/cron_guidelines',
    guideline: `Cron syntax:
\`\`\`ts
import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";
const crons = cronJobs();
crons.interval("job name", { hours: 2 }, internal.crons.myFunction, {});
export default crons;
\`\`\``,
  },
  {
    section: 'scheduling_guidelines/cron_guidelines',
    guideline:
      'If a cron calls an internal function, always import `internal` from "_generated/api", even if the function is in the same file.',
  },
  // File Storage Guidelines
  {
    section: 'file_storage_guidelines',
    guideline: 'Convex includes file storage for large files (images, videos, PDFs).',
  },
  {
    section: 'file_storage_guidelines',
    guideline:
      '`ctx.storage.getUrl()` returns a signed URL for a file, or null if file does not exist.',
  },
  {
    section: 'file_storage_guidelines',
    guideline:
      'Do NOT use deprecated `ctx.storage.getMetadata`. Query the `_storage` system table instead using `ctx.db.system.get(args.fileId)`.',
  },
  {
    section: 'file_storage_guidelines',
    guideline: 'Convex storage stores items as `Blob` objects. Convert to/from Blob when using storage.',
  },
];

/**
 * Convert Windows path to Git Bash path format
 */
export function toGitBashPath(windowsPath: string): string {
  let path = windowsPath.replace(/\\/g, '/');
  path = path.replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`);
  return path;
}

/**
 * Read the last line of a file (like tail -1)
 */
function readLastLine(filePath: string): string {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.trim().split('\n');
  return lines[lines.length - 1] || '';
}

/**
 * Read a file and extract lines matching a pattern (like grep)
 */
function grepFile(filePath: string, patterns: RegExp[], maxLines = 20): string[] {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const matches: string[] = [];

  for (const line of lines) {
    if (matches.length >= maxLines) break;
    for (const pattern of patterns) {
      if (pattern.test(line)) {
        matches.push(line);
        break;
      }
    }
  }

  return matches;
}

/**
 * Read the last N lines of a file (like tail -N)
 */
function readLastLines(filePath: string, n: number): string[] {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.trim().split('\n');
  return lines.slice(-n);
}

/**
 * Create custom MCP tools for the orchestrator
 */
/**
 * Parse results.jsonl and extract summary data
 */
export function parseResultsSummary(resultsPath: string): {
  passed: number;
  failed: number;
  total: number;
  failures: string[];
  results: Array<{ evalName: string; passed: boolean; [key: string]: unknown }>;
} | null {
  if (!existsSync(resultsPath)) return null;

  try {
    const lastLine = readLastLine(resultsPath);
    const data = JSON.parse(lastLine);

    // Handle both formats: {results: [...]} or {individual_results: [...]}
    const results = data.results || data.individual_results || [];

    const passed = results.filter((r: { passed?: boolean }) => r.passed === true).length;
    const failed = results.filter((r: { passed?: boolean }) => r.passed === false).length;
    const failures = results
      .filter((r: { passed?: boolean }) => r.passed === false)
      .map((r: { evalName?: string; category?: string; name?: string }) =>
        r.evalName || `${r.category}/${r.name}`
      );

    return { passed, failed, total: results.length, failures, results };
  } catch {
    return null;
  }
}

/**
 * Classify error lines into a pattern category
 */
export function classifyErrorPattern(errorLines: string): string {
  if (errorLines.includes('v.json is not a function') || errorLines.includes('i.json is not a function'))
    return 'v.json() does not exist';
  if (errorLines.includes('v.dict is not a function') || errorLines.includes('a.dict is not a function'))
    return 'v.dict() does not exist';
  if (errorLines.includes('"use node"') && errorLines.includes('Mutation'))
    return 'mutations in "use node" file';
  if (errorLines.includes('"use node"') && errorLines.includes('not allowed'))
    return '"use node" not allowed';
  if (errorLines.includes('pageStatus') || errorLines.includes('splitCursor'))
    return 'pagination returns validator incomplete';
  // Check for text search errors - look for 'search' and 'does not exist' or 'not a function'
  if ((errorLines.includes('.search') || errorLines.includes("'search'") || errorLines.includes('"search"')) &&
      (errorLines.includes('does not exist') || errorLines.includes('not a function')))
    return 'wrong text search API';
  if (errorLines.includes('.range')) return 'wrong index range API';
  if (errorLines.includes('null') && errorLines.includes('string'))
    return 'nullable return type not handled';
  if (errorLines.trim()) return errorLines.split('\n')[0].slice(0, 80);
  return 'unknown';
}

export function createOrchestratorTools(
  workspaceRoot: string,
  outputDir: string,
  resultsPath: string,
  modelName: string
) {
  return createSdkMcpServer({
    name: 'orchestrator-tools',
    version: '1.0.0',
    tools: [
      // Tool to get eval summary (minimal context usage)
      tool(
        'GetEvalSummary',
        'Get a summary of the eval results including pass/fail counts and list of failed eval names. Returns minimal data to conserve context.',
        {},
        async () => {
          const summary = parseResultsSummary(resultsPath);
          if (!summary) {
            return { content: [{ type: 'text', text: 'Error: results.jsonl not found or invalid' }] };
          }

          const result = {
            passed: summary.passed,
            failed: summary.failed,
            total: summary.total,
            failures: summary.failures,
          };

          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }
      ),

      // Tool to get details for a specific failed eval
      tool(
        'GetFailedEvalDetails',
        'Get detailed information for a specific failed eval including paths to task, expected answer, generated output, and run log. Use this before delegating to failure-analyser.',
        {
          evalName: z.string().describe('The eval name like "002-queries/009-text_search"'),
        },
        async ({ evalName }) => {
          const summary = parseResultsSummary(resultsPath);
          if (!summary) {
            return { content: [{ type: 'text', text: 'Error: results.jsonl not found or invalid' }] };
          }

          // Find the eval result
          const evalResult = summary.results.find((r) => {
            const name = r.evalName || `${r.category}/${r.name}`;
            return name === evalName;
          });

          if (!evalResult) {
            return { content: [{ type: 'text', text: `Error: Eval "${evalName}" not found in results` }] };
          }

          // Build paths
          const result = {
            evalName,
            passed: evalResult.passed,
            taskPath: join(workspaceRoot, 'evals', evalName, 'TASK.txt'),
            expectedDir: join(workspaceRoot, 'evals', evalName, 'answer', 'convex'),
            outputDir: join(outputDir, 'output', modelName, evalName, 'convex'),
            runLogPath: join(outputDir, 'output', modelName, evalName, 'run.log'),
            // Also provide Git Bash versions for subagent
            bashPaths: {
              taskPath: toGitBashPath(join(workspaceRoot, 'evals', evalName, 'TASK.txt')),
              expectedDir: toGitBashPath(join(workspaceRoot, 'evals', evalName, 'answer', 'convex')),
              outputDir: toGitBashPath(join(outputDir, 'output', modelName, evalName, 'convex')),
              runLogPath: toGitBashPath(join(outputDir, 'output', modelName, evalName, 'run.log')),
            },
          };

          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }
      ),

      // Tool to get run log error summary (just the error, not full log)
      tool(
        'GetRunLogError',
        'Extract just the error message from a run.log file. Returns only the relevant error lines to conserve context.',
        {
          evalName: z.string().describe('The eval name like "002-queries/009-text_search"'),
        },
        async ({ evalName }) => {
          // Try to find the run.log - path is output/{modelName}/{evalName}/run.log
          const runLogPath = join(outputDir, 'output', modelName, evalName, 'run.log');

          if (!existsSync(runLogPath)) {
            return { content: [{ type: 'text', text: `Error: run.log not found at ${runLogPath}` }] };
          }

          // Extract error lines using pure Node.js
          const errorPatterns = [/error/i, /fail/i, /exception/i, /TypeError/i, /SyntaxError/i, /ReferenceError/i];
          const errors = grepFile(runLogPath, errorPatterns, 20);

          if (errors.length === 0) {
            // If no explicit errors, get the last 10 lines which often contain the issue
            const lastLines = readLastLines(runLogPath, 10);
            return {
              content: [{ type: 'text', text: `No explicit errors found. Last 10 lines:\n${lastLines.join('\n')}` }],
            };
          }

          return { content: [{ type: 'text', text: errors.join('\n') }] };
        }
      ),

      // Tool to group failures by error pattern
      tool(
        'GroupFailuresByPattern',
        'Analyze all failed evals and group them by similar error patterns. Returns groups with representative eval for each pattern.',
        {},
        async () => {
          const summary = parseResultsSummary(resultsPath);
          if (!summary) {
            return { content: [{ type: 'text', text: 'Error: results.jsonl not found or invalid' }] };
          }

          // Group by error pattern
          const patterns: Record<string, { pattern: string; evals: string[]; sample: string }> = {};

          for (const evalName of summary.failures) {
            const runLogPath = join(outputDir, 'output', modelName, evalName, 'run.log');
            if (!existsSync(runLogPath)) continue;

            // Extract error lines using pure Node.js
            const errorPatterns = [/error/i, /fail/i, /TypeError/i, /SyntaxError/i];
            const errorLines = grepFile(runLogPath, errorPatterns, 5).join('\n');

            // Classify the error pattern
            const patternKey = classifyErrorPattern(errorLines);

            if (!patterns[patternKey]) {
              patterns[patternKey] = { pattern: patternKey, evals: [], sample: errorLines };
            }
            patterns[patternKey].evals.push(evalName);
          }

          // Format output
          const result = Object.values(patterns).map((p) => ({
            pattern: p.pattern,
            count: p.evals.length,
            representative: p.evals[0],
            allEvals: p.evals,
            sampleError: p.sample.slice(0, 200),
          }));

          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }
      ),

      // Tool to update checkpoint
      tool(
        'SaveCheckpoint',
        'Copy working guidelines to checkpoint. Call this when you achieve a new best pass count.',
        {
          workingGuidelinesPath: z.string().describe('Path to working_guidelines.txt'),
          checkpointPath: z.string().describe('Path to checkpoint_guidelines.txt'),
        },
        async ({ workingGuidelinesPath, checkpointPath }) => {
          try {
            copyFileSync(workingGuidelinesPath, checkpointPath);
            return { content: [{ type: 'text', text: 'Checkpoint saved successfully' }] };
          } catch (error) {
            return { content: [{ type: 'text', text: `Error saving checkpoint: ${error}` }] };
          }
        }
      ),

      // Tool to revert to checkpoint
      tool(
        'RevertToCheckpoint',
        'Revert working guidelines to the last checkpoint. Call this when you detect a regression.',
        {
          workingGuidelinesPath: z.string().describe('Path to working_guidelines.txt'),
          checkpointPath: z.string().describe('Path to checkpoint_guidelines.txt'),
        },
        async ({ workingGuidelinesPath, checkpointPath }) => {
          try {
            if (!existsSync(checkpointPath)) {
              return { content: [{ type: 'text', text: 'Error: No checkpoint exists to revert to' }] };
            }
            copyFileSync(checkpointPath, workingGuidelinesPath);
            return { content: [{ type: 'text', text: 'Reverted to checkpoint successfully' }] };
          } catch (error) {
            return { content: [{ type: 'text', text: `Error reverting to checkpoint: ${error}` }] };
          }
        }
      ),

      // Tool to get legacy guidelines
      tool(
        'GetLegacyGuidelines',
        'Get the legacy Convex guidelines from the original eval system. Use this to reference existing best practices when analyzing failures or creating new guidelines. Optionally filter by section.',
        {
          section: z
            .string()
            .optional()
            .describe(
              'Optional section filter like "function_guidelines", "pagination", "cron_guidelines", etc.'
            ),
        },
        async ({ section }) => {
          let guidelines = LEGACY_GUIDELINES;

          if (section) {
            guidelines = guidelines.filter(
              (g) => g.section.includes(section) || g.section.toLowerCase().includes(section.toLowerCase())
            );
          }

          if (guidelines.length === 0) {
            const sections = [...new Set(LEGACY_GUIDELINES.map((g) => g.section))];
            return {
              content: [
                {
                  type: 'text',
                  text: `No guidelines found for section "${section}". Available sections:\n${sections.join('\n')}`,
                },
              ],
            };
          }

          // Return as concise JSON
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(guidelines, null, 2),
              },
            ],
          };
        }
      ),
    ],
  });
}
