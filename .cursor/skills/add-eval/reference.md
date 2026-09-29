# Add-Eval Reference

Supplementary lookup doc for the add-eval skill. Keep workflow and sequencing in `SKILL.md`. Use this file for grader helpers, common test patterns, and durable conventions.

## Eval Pipelines

`getEvalPipeline` in `runner/scorer.ts` picks the pipeline from an optional `eval.json` in the eval directory. README.md ("Eval structure") describes the same options.

| Pipeline | `eval.json` | What runs | Grader imports from |
|----------|-------------|-----------|---------------------|
| backend (default) | none | install, deploy, tsc, eslint, then the grader against the deployed backend | `grader/index.ts` |
| static | `{ "pipeline": "static" }` | only the grader, on the raw generated files. No install, deploy, tsc or eslint | `grader/outputDir.ts` |
| module | `{ "pipeline": "module" }` | install, then the grader. No backend. The grader typechecks and executes the module itself | `grader/outputDir.ts` |

- **static** is for selection evals (AGENTS.md "Authoring New Evals"). It grades what the model chose and tolerates syntax errors and stale versions. Examples: the `choose_*` evals in `evals/007-components/`.
- **module** is for an answer that is a plain TypeScript module, not a Convex backend. The prompt asks for only the task's files, with no backend scaffolding. Example: `evals/001-data_modeling/015-validator_composition`.
- Static and module graders must not import `grader/index.ts`. It throws "CONVEX_PORT is not set" without a backend. `grader/outputDir.ts` exports `getLatestOutputProjectDir` and `readOutputFile`. The scorer sets `MODEL_OUTPUT_DIR` to the generated project in every pipeline.

## Grader Helper Catalog

Backend-pipeline graders import these helpers from `grader/index.ts` using
relative paths like `import { responseClient, addDocuments } from "../../../grader";`. Static and module graders import from `../../../grader/outputDir` instead (see Eval Pipelines).

### Clients

| Export | Type | Description |
|--------|------|-------------|
| `responseClient` | `ConvexClient` | Client connected to the **model's** deployed backend. Use for calling the model's public functions. |
| `responseAdminClient` | `ConvexClient` (admin) | Admin client for the model's backend. Used for data seeding, schema inspection, and internal function calls. |
| `answerAdminClient` | `ConvexClient \| null` (admin) | Admin client for the **answer** backend. Only available when `CONVEX_ANSWER_PORT` is set. Used by `compareSchema` / `compareFunctionSpec`. |
| `cloudUrl` | `string` | `http://localhost:<CONVEX_PORT>` |
| `siteUrl` | `string` | `http://localhost:<CONVEX_SITE_PORT>` - use for HTTP action endpoint testing. |

### Data Helpers

| Helper | Signature | Description |
|--------|-----------|-------------|
| `addDocuments` | `(adminClient, table, documents[]) => Promise<void>` | Insert documents into a table via the admin API. |
| `listTable` | `(adminClient, table, limit?) => Promise<any[]>` | List documents from a table in ascending creation order. Default limit 32. |
| `deleteAllDocuments` | `(adminClient, tables[]) => Promise<Record<string, number>>` | Clear all documents from the given tables. Use for test cleanup. |
| `pollUntil` | `(predicate, { timeoutMs, intervalMs }) => Promise<void>` | Poll until the predicate returns true, or throw after `timeoutMs`. Use instead of fixed sleeps (pattern 11). |

### Output Files

| Helper | Signature | Description |
|--------|-----------|-------------|
| `getLatestOutputProjectDir` | `(category, name) => string` | Path of the model's generated project. Also exported from `grader/outputDir.ts`. |
| `readOutputFile` | `(category, name, relativePath) => string` | Read one generated file, e.g. for AST checks. Also exported from `grader/outputDir.ts`. |

### Schema Inspection

| Helper | Signature | Description |
|--------|-----------|-------------|
| `compareSchema` | `(skip) => Promise<void>` | Compare the model's schema to the answer's schema. Skips if answer backend unavailable. |
| `compareFunctionSpec` | `(skip, options?) => Promise<void>` | Compare the model's exported function signatures to the answer's. Always pass `{ ignoreReturns: true }` (pattern 6). |
| `getSchema` | `(adminClient) => Promise<any>` | Fetch the active schema from a backend. Returns parsed JSON with `tables` array. |
| `findTable` | `(schema, tableName) => object \| null` | Find a table definition in a schema object. |
| `hasIndexForFields` | `(schema, tableName, fields[]) => boolean` | Check if a table has an index with exactly the given fields (in order). |
| `hasIndexForPrefix` | `(schema, tableName, fieldsPrefix[]) => boolean` | Check if a table has an index whose fields start with the given prefix. |

### AI Grading (currently disabled)

| Helper | Signature | Description |
|--------|-----------|-------------|
| `createAIGraderTest` | `(testFileUrl, name?, timeoutMs?) => void` | Intended to create a Vitest test that uses GPT to grade the model's output against TASK.txt. It is currently a no-op and requires a repo change in `grader/aiGrader.ts` before it will run anything. |

Import from `grader/aiGrader`:
```typescript
import { createAIGraderTest } from "../../../grader/aiGrader";
createAIGraderTest(import.meta.url);
```

## Common Test Patterns

### 1. Schema comparison

When the TASK.txt specifies an exact schema, include a schema comparison test:

```typescript
import { compareSchema } from "../../../grader";

test("compare schema", async ({ skip }) => {
  await compareSchema(skip);
});
```

### 2. Behavior testing with typed API

When function names and file paths are fixed, import the answer's generated API for type safety:

```typescript
import { api } from "./answer/convex/_generated/api";

test("creates a user", async () => {
  const id = await responseClient.mutation(api.users.create, { name: "Alice" });
  expect(id).toBeDefined();
});
```

### 3. Behavior testing with anyApi

When the model might place functions in different files, use `anyApi` for flexible path resolution:

```typescript
import { anyApi } from "convex/server";

test("query works", async () => {
  const result = await responseClient.query(anyApi.public.getMessages, {});
  expect(result).toEqual([]);
});
```

### 4. Data seeding and cleanup

Seed test data before assertions, clean up between tests if needed:

```typescript
import { responseAdminClient, addDocuments, deleteAllDocuments, listTable } from "../../../grader";

test("filters correctly", async () => {
  await addDocuments(responseAdminClient, "messages", [
    { text: "hello", author: "alice", isPinned: true, likes: 10 },
    { text: "world", author: "alice", isPinned: false, likes: 5 },
  ]);

  const result = await responseClient.query(anyApi.public.getPinned, { author: "alice" });
  expect(result).toHaveLength(1);
  expect(result[0].text).toBe("hello");
});
```

### 5. Cleanup with `afterEach`

When tests mutate backend state, clear relevant tables after each test so cases stay independent:

```typescript
import { afterEach } from "vitest";
import { responseAdminClient, deleteAllDocuments } from "../../../grader";

afterEach(async () => {
  await deleteAllDocuments(responseAdminClient, ["messages", "users"]);
});
```

### 6. Function spec comparison

When the task fixes exported public/internal function names or locations, compare the function spec against the answer. Graders must be returns-neutral (AGENTS.md), so always pass `ignoreReturns: true`:

```typescript
import { compareFunctionSpec } from "../../../grader";

test("compare function spec", async ({ skip }) => {
  await compareFunctionSpec(skip, { ignoreReturns: true });
});
```

- Add `publicOnly: true` when the task doesn't dictate internal function names or modules.
- Add `allowAdditionalFunctions: true` when the task names required functions but allows extra helper exports.

### 7. HTTP endpoint testing

For HTTP action evals, fetch against the site URL:

```typescript
import { siteUrl } from "../../../grader";

test("GET /api/health returns 200", async () => {
  const res = await fetch(`${siteUrl}/api/health`);
  expect(res.status).toBe(200);
  const data = await res.json();
  expect(data.ok).toBe(true);
});
```

### 8. Argument validation

Verify that validators reject bad input:

```typescript
test("rejects invalid arguments", async () => {
  await expect(
    responseClient.mutation(api.index.createUser, { name: 123 } as any),
  ).rejects.toThrow(/ArgumentValidationError/);
});
```

### 9. Function type checking

Verify a query can't be called as a mutation (and vice versa):

```typescript
test("is a query, not a mutation", async () => {
  await expect(
    responseClient.mutation(api.index.getUsers as any, {}),
  ).rejects.toBeDefined();
});
```

### 10. Schema/index inspection (without answer comparison)

When you need to check index structure directly:

```typescript
import { getSchema, hasIndexForFields } from "../../../grader";

test("has correct indexes", async () => {
  const schema = await getSchema(responseAdminClient);
  expect(hasIndexForFields(schema, "messages", ["author", "createdAt"])).toBe(true);
});
```

### 11. Waiting on scheduled work

Never use fixed sleeps. Poll with `pollUntil`, and give slow poll-based tests an explicit vitest timeout above `timeoutMs`:

```typescript
import { listTable, pollUntil, responseAdminClient, responseClient } from "../../../grader";

test("scheduled job completes", { timeout: 90_000 }, async () => {
  await responseClient.mutation(api.index.startJob, {});
  await pollUntil(
    async () => {
      const jobs = await listTable(responseAdminClient, "jobs");
      return jobs.every((job) => job.status === "done");
    },
    { timeoutMs: 60_000, intervalMs: 250 },
  );
});
```

The grader's summed per-test timeouts must stay under the scorer's vitest budget (`TIMEOUTS.vitest` in `runner/scorer.ts`).

## Test Approach Decision Tree

Use this to decide how to grade an eval:

```
Can the concept be verified by calling the function and checking the return value?
├── YES -> Use behavior tests (patterns 2-4 above)
│   └── Does the task specify an exact schema?
│       ├── YES -> Also add compareSchema test (pattern 1)
│       └── NO  -> Skip schema comparison
│
└── NO (concept is about HOW the code is structured, not WHAT it returns)
    ├── Is it about schema/index design?
    │   └── YES -> Use schema inspection helpers (pattern 10)
    │       hasIndexForFields, hasIndexForPrefix, getSchema
    │
    ├── Is it about which files/functions are exported?
    │   └── YES -> Use compareFunctionSpec with { ignoreReturns: true } (pattern 6)
    │
    ├── Is it about HTTP endpoint routing?
    │   └── YES -> Use HTTP endpoint testing (pattern 7)
    │
    ├── Is it about which component or pattern the model chose, unprompted?
    │   └── YES -> Selection eval: static pipeline, AST checks on the generated files
    │
    └── Is it about code style, patterns, or internal structure?
        └── STOP and discuss with user. Options:
            a. AI grading (createAIGraderTest) - currently a no-op, requires a repo change before it can be used
            b. AST analysis - parse the generated .ts files and check for specific patterns
            c. Restructure the eval so the concept CAN be tested via behavior
            d. Accept that this concept isn't well-suited for automated eval
```

## Grading the Model's Own Tests

Some evals ask the model to write its own test suite (e.g. `convex-test` evals). The grader can execute the model's tests using `MODEL_OUTPUT_DIR`, an environment variable set by the scorer that points to the model's generated project directory.

```typescript
import { execSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";

test("model's test suite passes", () => {
  const outputDir = process.env.MODEL_OUTPUT_DIR;
  if (!outputDir) throw new Error("MODEL_OUTPUT_DIR not set");

  expect(existsSync(join(outputDir, "convex/tasks.test.ts"))).toBe(true);

  const vitestBin = join(outputDir, "node_modules", ".bin", "vitest");
  const stdout = execSync(
    `"${vitestBin}" run --reporter=json --no-color 2>&1`,
    {
      cwd: outputDir,
      encoding: "utf-8",
      timeout: 60000,
      shell: process.platform === "win32" ? "cmd.exe" : "/bin/sh",
    },
  );
  // parse JSON output and assert
});
```

**Important:** Always use the explicit binary path (`node_modules/.bin/vitest`) instead of `bunx vitest`. The grader runs inside the scorer's vitest process, and `bunx` can resolve to the wrong binary in nested vitest contexts. Also avoid being too prescriptive about test structure (e.g. minimum test count). Models validly write single integration tests or many small unit tests.

## TASK.txt Conventions

### What to include

- Complete schema in a TypeScript code block (when applicable)
- Exact function names, argument types, and return shapes
- Which files to create (`convex/schema.ts`, `convex/index.ts`, etc.)
- What NOT to create (if relevant)
- Edge case behaviors (what to return when no results, error messages, etc.)
- Problem domain context (what the feature does)

### What NOT to include

- Convex implementation details covered by the guidelines (e.g. how to use `internalMutation`, how pagination works internally, how to register crons)
- Step-by-step implementation instructions (we're testing knowledge, not instruction-following)
- Import statements or boilerplate

### Naming

- Eval directory names use underscores, no dashes: `017-pagination_join`, `002-userspace_filter`
- Category + eval names cannot contain dashes
- Number prefix is sequential within the category (check existing evals for the next number)

## Answer Conventions

AGENTS.md "Authoring New Evals" has the full rules. Don't put `returns:` validators in answers unless the task tests them (only `000-fundamentals/009-returns_validator` and `002-queries/018-pagination_returns_validator` do).

### package.json template

```json
{
  "name": "convexbot",
  "version": "1.0.0",
  "dependencies": {
    "convex": "^1.31.2"
  }
}
```

Component evals pin exact versions of `convex` and the component instead, e.g. `"convex": "1.41.0"` and `"@convex-dev/aggregate": "0.2.2"`. Copy the pins from a sibling in `evals/007-components/`.

### Directory structure

```
answer/
├── package.json
└── convex/
    ├── schema.ts          (if eval uses a schema)
    ├── tsconfig.json      (copied from a sibling eval)
    ├── _generated/        (copied from a sibling eval)
    │   ├── api.d.ts
    │   ├── api.js
    │   ├── dataModel.d.ts
    │   ├── server.d.ts
    │   └── server.js
    └── <implementation>.ts (index.ts, public.ts, users.ts, etc.)
```

### Generated types

`bunx convex codegen` fails without a deployment ("No CONVEX_DEPLOYMENT set"). Copy `answer/convex/_generated` and `answer/convex/tsconfig.json` from a sibling single-module eval with the same files:

```bash
cp -R evals/<sibling>/answer/convex/_generated evals/<sibling>/answer/convex/tsconfig.json evals/<category>/<eval>/answer/convex/
```

`api.d.ts` imports each module by file name (e.g. `../index.js`) and `dataModel.d.ts` imports `../schema.js` when a schema exists, so match the sibling's files or edit those imports. Most answers have `convex/index.ts` and `convex/schema.ts`. For a component eval, copy from a sibling that mounts the same component. Recheck the imports if you add a module or a schema later. The grader imports types from `./answer/convex/_generated/api`, so `_generated` must exist before tests will compile. The scorer regenerates it when it deploys.
