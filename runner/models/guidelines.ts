/**
 * Convex coding guidelines and best practices.
 * These are included in prompts to help AI models generate correct Convex code.
 */

export interface Guideline {
  kind: "guideline";
  content: string;
}

export interface GuidelineSection {
  kind: "section";
  name: string;
  children: Array<Guideline | GuidelineSection>;
}

type GuidelineNode = Guideline | GuidelineSection;

function guideline(content: string): Guideline {
  return { kind: "guideline", content: content.trim() };
}

function section(
  name: string,
  children: GuidelineNode[],
): GuidelineSection {
  return { kind: "section", name, children };
}

export const CONVEX_GUIDELINES: GuidelineSection = section("convex_guidelines", [
  section("function_guidelines", [
    section("new_function_syntax", [
      guideline(`ALWAYS use the new function syntax for Convex functions. For example:
\`\`\`typescript
import { query } from "./_generated/server";
import { v } from "convex/values";
export const f = query({
    args: {},
    handler: async (ctx, args) => {
    // Function body
    },
});
\`\`\``),
    ]),
    section("http_endpoint_syntax", [
      guideline(`HTTP endpoints are defined in \`convex/http.ts\` and require an \`httpAction\` decorator. For example:
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
\`\`\``),
      guideline(
        'HTTP endpoints are always registered at the exact path you specify in the `path` field. For example, if you specify `/api/someRoute`, the endpoint will be registered at `/api/someRoute`.',
      ),
    ]),
    section("validators", [
      guideline(`Below is an example of an array validator:
\`\`\`typescript
import { mutation } from "./_generated/server";
import { v } from "convex/values";

export default mutation({
args: {
    simpleArray: v.array(v.union(v.string(), v.number())),
},
handler: async (ctx, args) => {
    //...
},
});
\`\`\``),
      guideline(`Below is an example of a schema with validators that codify a discriminated union type:
\`\`\`typescript
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
    results: defineTable(
        v.union(
            v.object({
                kind: v.literal("error"),
                errorMessage: v.string(),
            }),
            v.object({
                kind: v.literal("success"),
                value: v.number(),
            }),
        ),
    )
});
\`\`\``),
      guideline(`Here are the valid Convex types along with their respective validators:
Convex Type  | TS/JS type  |  Example Usage         | Validator for argument validation and schemas  | Notes                                                                                                                                                                                                 |
| ----------- | ------------| -----------------------| -----------------------------------------------| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Id          | string      | \`doc._id\`              | \`v.id(tableName)\`                              |                                                                                                                                                                                                       |
| Null        | null        | \`null\`                 | \`v.null()\`                                     | JavaScript's \`undefined\` is not a valid Convex value. Functions the return \`undefined\` or do not return will return \`null\` when called from a client. Use \`null\` instead.                             |
| Int64       | bigint      | \`3n\`                   | \`v.int64()\`                                    | Int64s only support BigInts between -2^63 and 2^63-1. Convex supports \`bigint\`s in most modern browsers.                                                                                              |
| Float64     | number      | \`3.1\`                  | \`v.number()\`                                   | Convex supports all IEEE-754 double-precision floating point numbers (such as NaNs). Inf and NaN are JSON serialized as strings.                                                                      |
| Boolean     | boolean     | \`true\`                 | \`v.boolean()\`                                  |
| String      | string      | \`"abc"\`                | \`v.string()\`                                   | Strings are stored as UTF-8 and must be valid Unicode sequences. Strings must be smaller than the 1MB total size limit when encoded as UTF-8.                                                         |
| Bytes       | ArrayBuffer | \`new ArrayBuffer(8)\`   | \`v.bytes()\`                                    | Convex supports first class bytestrings, passed in as \`ArrayBuffer\`s. Bytestrings must be smaller than the 1MB total size limit for Convex types.                                                     |
| Array       | Array       | \`[1, 3.2, "abc"]\`      | \`v.array(values)\`                              | Arrays can have at most 8192 values.                                                                                                                                                                  |
| Object      | Object      | \`{a: "abc"}\`           | \`v.object({property: value})\`                  | Convex only supports "plain old JavaScript objects" (objects that do not have a custom prototype). Objects can have at most 1024 entries. Field names must be nonempty and not start with "$" or "_". |
| Record      | Record      | \`{"a": "1", "b": "2"}\` | \`v.record(keys, values)\`                       | Records are objects at runtime, but can have dynamic keys. Keys must be only ASCII characters, nonempty, and not start with "$" or "_".                                                               |`),
    ]),
    section("function_registration", [
      guideline(
        "Use `internalQuery`, `internalMutation`, and `internalAction` to register internal functions. These functions are private and aren't part of an app's API. They can only be called by other Convex functions. These functions are always imported from `./_generated/server`.",
      ),
      guideline(
        "Use `query`, `mutation`, and `action` to register public functions. These functions are part of the public API and are exposed to the public Internet. Do NOT use `query`, `mutation`, or `action` to register sensitive internal functions that should be kept private.",
      ),
      guideline(
        "You CANNOT register a function through the `api` or `internal` objects.",
      ),
      guideline(
        "ALWAYS include argument validators for all Convex functions. This includes all of `query`, `internalQuery`, `mutation`, `internalMutation`, `action`, and `internalAction`.",
      ),
      guideline(
        "If the JavaScript implementation of a Convex function doesn't have a return value, it implicitly returns `null`.",
      ),
    ]),
    section("function_calling", [
      guideline("Use `ctx.runQuery` to call a query from a query, mutation, or action."),
      guideline("Use `ctx.runMutation` to call a mutation from a mutation or action."),
      guideline("Use `ctx.runAction` to call an action from an action."),
      guideline(
        "ONLY call an action from another action if you need to cross runtimes (e.g. from V8 to Node). Otherwise, pull out the shared code into a helper async function and call that directly instead.",
      ),
      guideline(
        "Try to use as few calls from actions to queries and mutations as possible. Queries and mutations are transactions, so splitting logic up into multiple calls introduces the risk of race conditions.",
      ),
      guideline(
        "All of these calls take in a `FunctionReference`. Do NOT try to pass the callee function directly into one of these calls.",
      ),
      guideline(`When using \`ctx.runQuery\`, \`ctx.runMutation\`, or \`ctx.runAction\` to call a function in the same file, specify a type annotation on the return value to work around TypeScript circularity limitations. For example,
\`\`\`
export const f = query({
  args: { name: v.string() },
  handler: async (ctx, args) => {
    return "Hello " + args.name;
  },
});

export const g = query({
  args: {},
  handler: async (ctx, args) => {
    const result: string = await ctx.runQuery(api.example.f, { name: "Bob" });
    return null;
  },
});
\`\`\``),
    ]),
    section("function_references", [
      guideline("Function references are pointers to registered Convex functions."),
      guideline(
        "Use the `api` object defined by the framework in `convex/_generated/api.ts` to call public functions registered with `query`, `mutation`, or `action`.",
      ),
      guideline(
        "Use the `internal` object defined by the framework in `convex/_generated/api.ts` to call internal (or private) functions registered with `internalQuery`, `internalMutation`, or `internalAction`.",
      ),
      guideline(
        "Convex uses file-based routing, so a public function defined in `convex/example.ts` named `f` has a function reference of `api.example.f`.",
      ),
      guideline(
        "A private function defined in `convex/example.ts` named `g` has a function reference of `internal.example.g`.",
      ),
      guideline(
        "Functions can also registered within directories nested within the `convex/` folder. For example, a public function `h` defined in `convex/messages/access.ts` has a function reference of `api.messages.access.h`.",
      ),
    ]),
    section("api_design", [
      guideline(
        "Convex uses file-based routing, so thoughtfully organize files with public query, mutation, or action functions within the `convex/` directory.",
      ),
      guideline("Use `query`, `mutation`, and `action` to define public functions."),
      guideline(
        "Use `internalQuery`, `internalMutation`, and `internalAction` to define private, internal functions.",
      ),
    ]),
    section("pagination", [
      guideline("Paginated queries are queries that return a list of results in incremental pages."),
      guideline(`You can define pagination using the following syntax:

\`\`\`ts
import { v } from "convex/values";
import { query, mutation } from "./_generated/server";
import { paginationOptsValidator } from "convex/server";
export const listWithExtraArg = query({
    args: { paginationOpts: paginationOptsValidator, author: v.string() },
    handler: async (ctx, args) => {
        return await ctx.db
        .query("messages")
        .withIndex("by_author", (q) => q.eq("author", args.author))
        .order("desc")
        .paginate(args.paginationOpts);
    },
});
\`\`\`
Note: \`paginationOpts\` is an object with the following properties:
- \`numItems\`: the maximum number of documents to return (the validator is \`v.number()\`)
- \`cursor\`: the cursor to use to fetch the next page of documents (the validator is \`v.union(v.string(), v.null())\`)`),
      guideline(`A query that ends in \`.paginate()\` returns an object that has the following properties:
- page (contains an array of documents that you fetches)
- isDone (a boolean that represents whether or not this is the last page of documents)
- continueCursor (a string that represents the cursor to use to fetch the next page of documents)`),
    ]),
  ]),
  section("validator_guidelines", [
    guideline(
      "`v.bigint()` is deprecated for representing signed 64-bit integers. Use `v.int64()` instead.",
    ),
    guideline(
      "Use `v.record()` for defining a record type. `v.map()` and `v.set()` are not supported.",
    ),
  ]),
  section("schema_guidelines", [
    guideline("Always define your schema in `convex/schema.ts`."),
    guideline("Always import the schema definition functions from `convex/server`."),
    guideline(
      'System fields are automatically added to all documents and are prefixed with an underscore. The two system fields that are automatically added to all documents are `_creationTime` which has the validator `v.number()` and `_id` which has the validator `v.id(tableName)`.',
    ),
    guideline(
      'Always include all index fields in the index name. For example, if an index is defined as `["field1", "field2"]`, the index name should be "by_field1_and_field2".',
    ),
    guideline(
      'Index fields must be queried in the same order they are defined. If you want to be able to query by "field1" then "field2" and by "field2" then "field1", you must create separate indexes.',
    ),
  ]),
  section("typescript_guidelines", [
    guideline(
      "You can use the helper typescript type `Id` imported from './_generated/dataModel' to get the type of the id for a given table. For example if there is a table called 'users' you can use `Id<'users'>` to get the type of the id for that table.",
    ),
    guideline(`If you need to define a \`Record\` make sure that you correctly provide the type of the key and value in the type. For example a validator \`v.record(v.id('users'), v.string())\` would have the type \`Record<Id<'users'>, string>\`. Below is an example of using \`Record\` with an \`Id\` type in a query:
\`\`\`ts
import { query } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";

export const exampleQuery = query({
    args: { userIds: v.array(v.id("users")) },
    handler: async (ctx, args) => {
        const idToUsername: Record<Id<"users">, string> = {};
        for (const userId of args.userIds) {
            const user = await ctx.db.get("users", userId);
            if (user) {
                idToUsername[user._id] = user.username;
            }
        }

        return idToUsername;
    },
});
\`\`\``),
    guideline(
      "Be strict with types, particularly around id's of documents. For example, if a function takes in an id for a document in the 'users' table, take in `Id<'users'>` rather than `string`.",
    ),
    guideline("Always use `as const` for string literals in discriminated union types."),
    guideline(
      "When using the `Array` type, make sure to always define your arrays as `const array: Array<T> = [...];`",
    ),
    guideline(
      "When using the `Record` type, make sure to always define your records as `const record: Record<KeyType, ValueType> = {...};`",
    ),
  ]),
  section("full_text_search_guidelines", [
    guideline(
      'A query for "10 messages in channel \'#general\' that best match the query \'hello hi\' in their body" would look like:\n\nconst messages = await ctx.db\n  .query("messages")\n  .withSearchIndex("search_body", (q) =>\n    q.search("body", "hello hi").eq("channel", "#general"),\n  )\n  .take(10);',
    ),
  ]),
  section("query_guidelines", [
    guideline(
      "Do NOT use `filter` in queries. Instead, define an index in the schema and use `withIndex` instead.",
    ),
    guideline(
      "Convex queries do NOT support `.delete()`. Instead, `.collect()` the results, iterate over them, and call `ctx.db.delete(row._id)` on each result.",
    ),
    guideline(
      "Use `.unique()` to get a single document from a query. This method will throw an error if there are multiple documents that match the query.",
    ),
    guideline(
      "When using async iteration, don't use `.collect()` or `.take(n)` on the result of a query. Instead, use the `for await (const row of query)` syntax.",
    ),
    section("ordering", [
      guideline(
        "By default Convex always returns documents in ascending `_creationTime` order.",
      ),
      guideline(
        "You can use `.order('asc')` or `.order('desc')` to pick whether a query is in ascending or descending order. If the order isn't specified, it defaults to ascending.",
      ),
      guideline(
        "Document queries that use indexes will be ordered based on the columns in the index and can avoid slow table scans.",
      ),
    ]),
  ]),
  section("mutation_guidelines", [
    guideline(
      'Use `ctx.db.replace` to fully replace an existing document. This method will throw an error if the document does not exist. Syntax: `await ctx.db.replace(\'tasks\', taskId, { name: \'Buy milk\', completed: false })`',
    ),
    guideline(
      "Use `ctx.db.patch` to shallow merge updates into an existing document. This method will throw an error if the document does not exist. Syntax: `await ctx.db.patch('tasks', taskId, { completed: true })`",
    ),
  ]),
  section("action_guidelines", [
    guideline(
      'Always add `"use node";` to the top of files containing actions that use Node.js built-in modules.',
    ),
    guideline(
      'Never add `"use node";` to a file that also exports queries or mutations. Only actions can run in the Node.js runtime; queries and mutations must stay in the default Convex runtime. If you need Node.js built-ins alongside queries or mutations, put the action in a separate file.',
    ),
    guideline(
      '`fetch()` is available in the default Convex runtime. You do NOT need `"use node";` just to use `fetch()`.',
    ),
    guideline(
      "Never use `ctx.db` inside of an action. Actions don't have access to the database.",
    ),
    guideline(`Below is an example of the syntax for an action:
\`\`\`ts
import { action } from "./_generated/server";

export const exampleAction = action({
    args: {},
    handler: async (ctx, args) => {
        console.log("This action does not return anything");
        return null;
    },
});
\`\`\``),
  ]),
  section("scheduling_guidelines", [
    section("cron_guidelines", [
      guideline(
        "Only use the `crons.interval` or `crons.cron` methods to schedule cron jobs. Do NOT use the `crons.hourly`, `crons.daily`, or `crons.weekly` helpers.",
      ),
      guideline(
        "Both cron methods take in a FunctionReference. Do NOT try to pass the function directly into one of these methods.",
      ),
      guideline(`Define crons by declaring the top-level \`crons\` object, calling some methods on it, and then exporting it as default. For example,
\`\`\`ts
import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";

const empty = internalAction({
  args: {},
  handler: async (ctx, args) => {
    console.log("empty");
  },
});

const crons = cronJobs();

// Run \`internal.crons.empty\` every two hours.
crons.interval("delete inactive users", { hours: 2 }, internal.crons.empty, {});

export default crons;
\`\`\``),
      guideline(
        "You can register Convex functions within `crons.ts` just like any other file.",
      ),
      guideline(
        "If a cron calls an internal function, always import the `internal` object from '_generated/api', even if the internal function is registered in the same file.",
      ),
    ]),
  ]),
  section("file_storage_guidelines", [
    guideline(
      "Convex includes file storage for large files like images, videos, and PDFs.",
    ),
    guideline(
      "The `ctx.storage.getUrl()` method returns a signed URL for a given file. It returns `null` if the file doesn't exist.",
    ),
    guideline(`Do NOT use the deprecated \`ctx.storage.getMetadata\` call for loading a file's metadata.

Instead, query the \`_storage\` system table. For example, you can use \`ctx.db.system.get\` to get an \`Id<"_storage">\`.
\`\`\`
import { query } from "./_generated/server";
import { Id } from "./_generated/dataModel";

type FileMetadata = {
    _id: Id<"_storage">;
    _creationTime: number;
    contentType?: string;
    sha256: string;
    size: number;
}

export const exampleQuery = query({
    args: { fileId: v.id("_storage") },
    handler: async (ctx, args) => {
        const metadata: FileMetadata | null = await ctx.db.system.get("_storage", args.fileId);
        console.log(metadata);
        return null;
    },
});
\`\`\``),
    guideline(
      "Convex storage stores items as `Blob` objects. You must convert all items to/from a `Blob` when using Convex storage.",
    ),
  ]),
]);

// ── Compact guidelines (ablation-validated for AGENTS.md) ───────────────────
// Excludes: validator_guidelines, full_text_search_guidelines;
// function_guidelines excludes new_function_syntax, function_references;
// validators, function_registration, function_calling, pagination are compacted.

export const COMPACT_CONVEX_GUIDELINES: GuidelineSection = section(
  "convex_guidelines",
  [
    section("function_guidelines", [
      section("http_endpoint_syntax", [
        guideline(`HTTP endpoints are defined in \`convex/http.ts\` and require an \`httpAction\` decorator. For example:
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
\`\`\``),
        guideline(
          'HTTP endpoints are always registered at the exact path you specify in the `path` field. For example, if you specify `/api/someRoute`, the endpoint will be registered at `/api/someRoute`.',
        ),
        guideline(
          'For prefix matching use `pathPrefix` instead of `path`: `http.route({ pathPrefix: "/api/", method: "GET", handler: ... })`. Do NOT use glob patterns like `/api/*`.',
        ),
      ]),
      section("validators", [
        guideline(
          "Use `v.array(validator)` for arrays, `v.union(...)` for unions, and `v.object({ ... })` for objects. Discriminated unions: use `v.literal(\"kind\")` with `v.object({ kind: v.literal(\"a\"), ... })`.",
        ),
        guideline(
          "Common validators: `v.id(tableName)`, `v.string()`, `v.number()`, `v.boolean()`, `v.int64()` (not v.bigint()), `v.record(keys, values)` (not v.map/v.set).",
        ),
        guideline(
          "There is NO `v.tuple()` validator. Use `v.array(v.union(...))` for mixed-type arrays.",
        ),
      ]),
      section("function_registration", [
        guideline(
          "Use `internalQuery`, `internalMutation`, `internalAction` for private functions (from `./_generated/server`). Use `query`, `mutation`, `action` for public API. Do not register via `api` or `internal` objects.",
        ),
        guideline(
          "ALWAYS include `args` validators for every function.",
        ),
      ]),
      section("function_calling", [
        guideline("Use `ctx.runQuery` to call a query from a query, mutation, or action."),
        guideline("Use `ctx.runMutation` to call a mutation from a mutation or action."),
        guideline("Use `ctx.runAction` to call an action from an action."),
        guideline(
          "Only call an action from another action when crossing runtimes (e.g. V8 to Node). Otherwise use a shared helper async function.",
        ),
        guideline(
          "Minimize action→query/mutation calls; each call is a separate transaction and can introduce race conditions.",
        ),
        guideline(
          "All calls take a FunctionReference (e.g. `api.module.f`). Do not pass the function directly. For same-file calls, add a type annotation on the return value to avoid TypeScript circularity.",
        ),
      ]),
      section("api_design", [
        guideline(
          "Convex uses file-based routing, so thoughtfully organize files with public query, mutation, or action functions within the `convex/` directory.",
        ),
        guideline("Use `query`, `mutation`, and `action` to define public functions."),
        guideline(
          "Use `internalQuery`, `internalMutation`, and `internalAction` to define private, internal functions.",
        ),
      ]),
      section("pagination", [
        guideline("Paginated queries return results in incremental pages via `.paginate(paginationOpts)`."),
        guideline(
          "Import `paginationOptsValidator` from `convex/server` and use `args: { paginationOpts: paginationOptsValidator, ... }`.",
        ),
        guideline(
          "Paginated return object has `page`, `isDone`, and `continueCursor` (NOT `results`).",
        ),
        guideline(`Example: \`args: { paginationOpts: paginationOptsValidator, ... }\`, then \`ctx.db.query(\"table\").withIndex(\"by_x\", q => q.eq(\"x\", args.x)).order(\"desc\").paginate(args.paginationOpts)\`.`),
      ]),
    ]),
    section("schema_guidelines", [
      guideline("Always define your schema in `convex/schema.ts`."),
      guideline("Always import the schema definition functions from `convex/server`."),
      guideline(
        'System fields are automatically added to all documents and are prefixed with an underscore. The two system fields that are automatically added to all documents are `_creationTime` which has the validator `v.number()` and `_id` which has the validator `v.id(tableName)`.',
      ),
      guideline(
        'Always include all index fields in the index name. For example, if an index is defined as `["field1", "field2"]`, the index name should be "by_field1_and_field2".',
      ),
      guideline(
        'Index fields must be queried in the same order they are defined. If you want to be able to query by "field1" then "field2" and by "field2" then "field1", you must create separate indexes.',
      ),
    ]),
    section("typescript_guidelines", [
      guideline(
        "You can use the helper typescript type `Id` imported from './_generated/dataModel' to get the type of the id for a given table. For example if there is a table called 'users' you can use `Id<'users'>` to get the type of the id for that table.",
      ),
      guideline(`If you need to define a \`Record\` make sure that you correctly provide the type of the key and value in the type. For example a validator \`v.record(v.id('users'), v.string())\` would have the type \`Record<Id<'users'>, string>\`. Below is an example of using \`Record\` with an \`Id\` type in a query:
\`\`\`ts
import { query } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";

export const exampleQuery = query({
    args: { userIds: v.array(v.id("users")) },
    handler: async (ctx, args) => {
        const idToUsername: Record<Id<"users">, string> = {};
        for (const userId of args.userIds) {
            const user = await ctx.db.get("users", userId);
            if (user) {
                idToUsername[user._id] = user.username;
            }
        }

        return idToUsername;
    },
});
\`\`\``),
      guideline(
        "Be strict with types, particularly around id's of documents. For example, if a function takes in an id for a document in the 'users' table, take in `Id<'users'>` rather than `string`.",
      ),
      guideline("Always use `as const` for string literals in discriminated union types."),
      guideline(
        "When using the `Array` type, make sure to always define your arrays as `const array: Array<T> = [...];`",
      ),
      guideline(
        "When using the `Record` type, make sure to always define your records as `const record: Record<KeyType, ValueType> = {...};`",
      ),
    ]),
    section("query_guidelines", [
      guideline(
        "Do NOT use `filter` in queries. Instead, define an index in the schema and use `withIndex` instead.",
      ),
      guideline(
        "Convex queries do NOT support `.delete()`. Instead, `.collect()` the results, iterate over them, and call `ctx.db.delete(row._id)` on each result.",
      ),
      guideline(
        "Use `.unique()` to get a single document from a query. This method will throw an error if there are multiple documents that match the query.",
      ),
      guideline(
        "When using async iteration, don't use `.collect()`, `.take(n)`, or `.iter()` on the result of a query. Use `for await (const row of query)` directly.",
      ),
      section("ordering", [
        guideline(
          "By default Convex always returns documents in ascending `_creationTime` order.",
        ),
        guideline(
          "You can use `.order('asc')` or `.order('desc')` to pick whether a query is in ascending or descending order. If the order isn't specified, it defaults to ascending.",
        ),
        guideline(
          "Document queries that use indexes will be ordered based on the columns in the index and can avoid slow table scans.",
        ),
      ]),
    ]),
    section("mutation_guidelines", [
      guideline(
        'Use `ctx.db.replace` to fully replace an existing document. This method will throw an error if the document does not exist. Syntax: `await ctx.db.replace(\'tasks\', taskId, { name: \'Buy milk\', completed: false })`',
      ),
      guideline(
        "Use `ctx.db.patch` to shallow merge updates into an existing document. This method will throw an error if the document does not exist. Syntax: `await ctx.db.patch('tasks', taskId, { completed: true })`",
      ),
    ]),
    section("action_guidelines", [
      guideline(
        'Always add `"use node";` to the top of files containing actions that use Node.js built-in modules.',
      ),
      guideline(
        'Never add `"use node";` to a file that also exports queries or mutations. Only actions can run in the Node.js runtime; queries and mutations must stay in the default Convex runtime. If you need Node.js built-ins alongside queries or mutations, put the action in a separate file.',
      ),
      guideline(
        '`fetch()` is available in the default Convex runtime. You do NOT need `"use node";` just to use `fetch()`.',
      ),
      guideline(
        "Never use `ctx.db` inside of an action. Actions don't have access to the database.",
      ),
      guideline(`Below is an example of the syntax for an action:
\`\`\`ts
import { action } from "./_generated/server";

export const exampleAction = action({
    args: {},
    handler: async (ctx, args) => {
        console.log("This action does not return anything");
        return null;
    },
});
\`\`\``),
    ]),
    section("scheduling_guidelines", [
      section("cron_guidelines", [
        guideline(
          "Only use the `crons.interval` or `crons.cron` methods to schedule cron jobs. Do NOT use the `crons.hourly`, `crons.daily`, or `crons.weekly` helpers.",
        ),
        guideline(
          "Both cron methods take in a FunctionReference. Do NOT try to pass the function directly into one of these methods.",
        ),
        guideline(`Define crons by declaring the top-level \`crons\` object, calling some methods on it, and then exporting it as default. For example,
\`\`\`ts
import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";

const empty = internalAction({
  args: {},
  handler: async (ctx, args) => {
    console.log("empty");
  },
});

const crons = cronJobs();

// Run \`internal.crons.empty\` every two hours.
crons.interval("delete inactive users", { hours: 2 }, internal.crons.empty, {});

export default crons;
\`\`\``),
        guideline(
          "You can register Convex functions within `crons.ts` just like any other file.",
        ),
        guideline(
          "If a cron calls an internal function, always import the `internal` object from '_generated/api', even if the internal function is registered in the same file.",
        ),
      ]),
    ]),
    section("file_storage_guidelines", [
      guideline(
        "Convex includes file storage for large files like images, videos, and PDFs.",
      ),
      guideline(
        "The `ctx.storage.getUrl()` method returns a signed URL for a given file. It returns `null` if the file doesn't exist.",
      ),
      guideline(`Do NOT use the deprecated \`ctx.storage.getMetadata\` call for loading a file's metadata.

Instead, query the \`_storage\` system table. For example, you can use \`ctx.db.system.get\` to get an \`Id<"_storage">\`.
\`\`\`
import { query } from "./_generated/server";
import { Id } from "./_generated/dataModel";

type FileMetadata = {
    _id: Id<"_storage">;
    _creationTime: number;
    contentType?: string;
    sha256: string;
    size: number;
}

export const exampleQuery = query({
    args: { fileId: v.id("_storage") },
    handler: async (ctx, args) => {
        const metadata: FileMetadata | null = await ctx.db.system.get("_storage", args.fileId);
        console.log(metadata);
        return null;
    },
});
\`\`\``),
      guideline(
        "Convex storage stores items as `Blob` objects. You must convert all items to/from a `Blob` when using Convex storage.",
      ),
      guideline(
        "Always use `new Blob([data])` to store and `await blob.text()` to read. Do NOT use `TextEncoder` or `TextDecoder` with Convex storage blobs.",
      ),
    ]),
  ],
);

/** Render the compact (AGENTS.md) guidelines tree as markdown. */
export function renderCompactGuidelines(): string {
  return renderGuidelines(COMPACT_CONVEX_GUIDELINES);
}

/** Render guidelines tree as markdown. */
export function renderGuidelines(
  node: Guideline | GuidelineSection,
  header = "#",
): string {
  if (node.kind === "guideline") {
    return `- ${node.content}\n`;
  }
  const words = node.name.split("_");
  words[0] = words[0].charAt(0).toUpperCase() + words[0].slice(1);
  let out = `${header} ${words.join(" ")}\n`;
  for (const child of node.children) {
    out += renderGuidelines(child, header + "#");
  }
  out += "\n";
  return out;
}
