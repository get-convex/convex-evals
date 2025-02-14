class Guideline:
    def __init__(self, content: str):
        self.content = content.strip()


class GuidelineSection:
    def __init__(self, name: str, children: list):
        self.name = name
        self.children = children


CONVEX_GUIDELINES = GuidelineSection(
    "convex_guidelines",
    [
        GuidelineSection(
            "function_guidelines",
            [
                GuidelineSection(
                    "new_function_syntax",
                    [
                        Guideline(
                            """
      ALWAYS use the new function syntax for Convex functions. For example:
      ```typescript
      import { query } from "./_generated/server";
      import { v } from "convex/values";
      export const f = query({
          args: {},
          returns: v.null(),
          handler: async (ctx, args) => {
          // Function body
          },
      });
      ```
      """
                        ),
                    ],
                ),
                GuidelineSection(
                    "http_endpoint_syntax",
                    [
                        Guideline(
                            """
      HTTP endpoints are defined in `convex/http.ts` and require an `httpAction` decorator. For example:
      ```typescript
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
      ```
      """
                        ),
                        Guideline(
                            "HTTP endpoints are always registered at the exact path you specify in the `path` field. For example, if you specify `/api/someRoute`, the endpoint will be registered at `/api/someRoute`."
                        ),
                    ],
                ),
                GuidelineSection(
                    "validators",
                    [
                        Guideline(
                            """Below is an example of an array validator:
                            ```typescript
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
                            ```
                            """
                        ),
                        Guideline(
                            """Below is an example of a schema with validators that codify a discriminated union type:
                            ```typescript
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
                            ```
                            """
                        ),
                        Guideline(
                            """Always use the `v.null()` validator when returning a null value. Below is an example query that returns a null value:
                                  ```typescript
                                  import { query } from "./_generated/server";
                                  import { v } from "convex/values";

                                  export const exampleQuery = query({
                                    args: {},
                                    returns: v.null(),
                                    handler: async (ctx, args) => {
                                        console.log("This query returns a null value");
                                        return null;
                                    },
                                  });
                                  ```"""
                        ),
                    ],
                ),
                GuidelineSection(
                    "function_registration",
                    [
                        Guideline(
                            "Use `internalQuery`, `internalMutation`, and `internalAction` to register internal functions. These functions are private and aren't part of an app's API. They can only be called by other Convex functions. These functions are always imported from `./_generated/server`."
                        ),
                        Guideline(
                            "Use `query`, `mutation`, and `action` to register public functions. These functions are part of the public API and are exposed to the public Internet. Do NOT use `query`, `mutation`, or `action` to register sensitive internal functions that should be kept private."
                        ),
                        Guideline(
                            "You CANNOT register a function through the `api` or `internal` objects."
                        ),
                        Guideline(
                            "ALWAYS include argument and return validators for all Convex functions. This includes all of `query`, `internalQuery`, `mutation`, `internalMutation`, `action`, and `internalAction`. If a function doesn't return anything, include `returns: v.null()` as its output validator."
                        ),
                        Guideline(
                            "If the JavaScript implementation of a Convex function doesn't have a return value, it implicitly returns `null`."
                        ),
                    ],
                ),
                GuidelineSection(
                    "function_calling",
                    [
                        Guideline(
                            "Use `ctx.runQuery` to call a query from a query, mutation, or action."
                        ),
                        Guideline(
                            "Use `ctx.runMutation` to call a mutation from a mutation or action."
                        ),
                        Guideline("Use `ctx.runAction` to call an action from an action."),
                        Guideline(
                            "ONLY call an action from another action if you need to cross runtimes (e.g. from V8 to Node). Otherwise, pull out the shared code into a helper async function and call that directly instead."
                        ),
                        Guideline(
                            "Try to use as few calls from actions to queries and mutations as possible. Queries and mutations are transactions, so splitting logic up into multiple calls introduces the risk of race conditions."
                        ),
                        Guideline(
                            "All of these calls take in a `FunctionReference`. Do NOT try to pass the callee function directly into one of these calls."
                        ),
                        Guideline(
                            """
                            When using `ctx.runQuery`, `ctx.runMutation`, or `ctx.runAction` to call a function in the same file, specify a type annotation on the return value to work around TypeScript circularity limitations. For example,
                            ```
                            export const f = query({
                              args: { name: v.string() },
                              returns: v.string(),
                              handler: async (ctx, args) => {
                                return "Hello " + args.name;
                              },
                            });

                            export const g = query({
                              args: {},
                              returns: v.null(),
                              handler: async (ctx, args) => {
                                const result: string = await ctx.runQuery(api.example.f, { name: "Bob" });
                                return null;
                              },
                            });
                            ```
                            """
                        ),
                    ],
                ),
                GuidelineSection(
                    "function_references",
                    [
                        Guideline(
                            "Function references are pointers to registered Convex functions."
                        ),
                        Guideline(
                            "Use the `api` object defined by the framework in `convex/_generated/api.ts` to call public functions registered with `query`, `mutation`, or `action`."
                        ),
                        Guideline(
                            "Use the `internal` object defined by the framework in `convex/_generated/api.ts` to call internal (or private) functions registered with `internalQuery`, `internalMutation`, or `internalAction`."
                        ),
                        Guideline(
                            "Convex uses file-based routing, so a public function defined in `convex/example.ts` named `f` has a function reference of `api.example.f`."
                        ),
                        Guideline(
                            "A private function defined in `convex/example.ts` named `g` has a function reference of `internal.example.g`."
                        ),
                        Guideline(
                            "Functions can also registered within directories nested within the `convex/` folder. For example, a public function `h` defined in `convex/messages/access.ts` has a function reference of `api.messages.access.h`."
                        ),
                    ],
                ),
                GuidelineSection(
                    "api_design",
                    [
                        Guideline(
                            "Convex uses file-based routing, so thoughtfully organize files with public query, mutation, or action functions within the `convex/` directory."
                        ),
                        Guideline(
                            "Use `query`, `mutation`, and `action` to define public functions."
                        ),
                        Guideline(
                            "Use `internalQuery`, `internalMutation`, and `internalAction` to define private, internal functions."
                        ),
                    ],
                ),
                GuidelineSection(
                    "pagination",
                    [
                        Guideline(
                            "Paginated queries are queries that return a list of results in incremental pages."
                        ),
                        Guideline(
                            """
                            You can define pagination using the following syntax:

                            ```ts
                            import { v } from "convex/values";
                            import { query, mutation } from "./_generated/server";
                            import { paginationOptsValidator } from "convex/server";
                            export const listWithExtraArg = query({
                                args: { paginationOpts: paginationOptsValidator, author: v.string() },
                                handler: async (ctx, args) => {
                                    return await ctx.db
                                    .query("messages")
                                    .filter((q) => q.eq(q.field("author"), args.author))
                                    .order("desc")
                                    .paginate(args.paginationOpts);
                                },
                            });
                            ```
                            """
                        ),
                        Guideline(
                            """A query that ends in `.paginate()` returns an object that has the following properties:
                            - page (contains an array of documents that you fetches)
                            - isDone (a boolean that represents whether or not this is the last page of documents)
                            - continueCursor (a string that represents the cursor to use to fetch the next page of documents)
                            """
                        ),
                    ],
                ),
            ],
        ),
        GuidelineSection(
            "validator_guidelines",
            [
                Guideline(
                    "`v.bigint()` is deprecated for representing signed 64-bit integers. Use `v.int64()` instead."
                ),
                Guideline(
                    "Use `v.record()` for defining a record type. `v.map()` and `v.set()` are not supported."
                ),
            ],
        ),
        GuidelineSection(
            "schema_guidelines",
            [
                Guideline("Always define your schema in `convex/schema.ts`."),
                Guideline("Always import the schema definition functions from `convex/server`:"),
                Guideline(
                    "System fields are automatically added to all documents and are prefixed with an underscore."
                ),
                Guideline(
                    """Always include all index fields in the index name. For example, if an index is defined as `["field1", "field2"]`, the index name should be "by_field1_and_field2"."""
                ),
                Guideline(
                    """Index fields must be queried in the same order they are defined. If you want to be able to query by "field1" then "field2" and by "field2" then "field1", you must create separate indexes."""
                ),
            ],
        ),
        GuidelineSection(
            "typescript_guidelines",
            [
                Guideline(
                    "You can use the helper typescript type `Id` imported from './_generated/dataModel' to get the type of the id for a given table. For example if there is a table called 'users' you can use `Id<'users'>` to get the type of the id for that table."
                ),
                Guideline(
                    """If you need to define a `Record` make sure that you correctly provide the type of the key and value in the type. For example a validator `v.record(v.id('users'), v.string())` would have the type `Record<Id<'users'>, string>`. Below is an example of using `Record` with an `Id` type in a query:
                    ```ts
                    import { query } from "./_generated/server";
                    import { Doc, Id } from "./_generated/dataModel";

                    export const exampleQuery = query({
                        args: { userIds: v.array(v.id("users")) },
                        returns: v.record(v.id("users"), v.string()),
                        handler: async (ctx, args) => {
                            const idToUsername: Record<Id<"users">, string> = {};
                            for (const userId of args.userIds) {
                                const user = await ctx.db.get(userId);
                                if (user) {
                                    users[user._id] = user.username;
                                }
                            }

                            return idToUsername;
                        },
                    });
                    ```
                    """
                ),
                Guideline(
                    "Be strict with types, particularly around id's of documents. For example, if a function takes in an id for a document in the 'users' table, take in `Id<'users'>` rather than `string`."
                ),
                Guideline(
                    "Always use `as const` for string literals in discriminated union types."
                ),
                Guideline(
                    "When using the `Array` type, make sure to always define your arrays as `const array: Array<T> = [...];`"
                ),
                Guideline(
                    "When using the `Record` type, make sure to always define your records as `const record: Record<KeyType, ValueType> = {...};`"
                ),
                Guideline(
                    "Always add `@types/node` to your `package.json` when using any Node.js built-in modules."
                ),
            ],
        ),
        GuidelineSection(
            "full_text_search_guidelines",
            [
                Guideline(
                    'A query for "10 messages in channel \'#general\' that best match the query \'hello hi\' in their body" would look like:\n\nconst messages = await ctx.db\n  .query("messages")\n  .withSearchIndex("search_body", (q) =>\n    q.search("body", "hello hi").eq("channel", "#general"),\n  )\n  .take(10);'
                ),
            ],
        ),
        GuidelineSection(
            "query_guidelines",
            [
                Guideline(
                    "Do NOT use `filter` in queries. Instead, define an index in the schema and use `withIndex` instead."
                ),
                Guideline(
                    "Convex queries do NOT support `.delete()`. Instead, `.collect()` the results, iterate over them, and call `ctx.db.delete(row._id)` on each result."
                ),
                Guideline(
                    "Use `.unique()` to get a single document from a query. This method will throw an error if there are multiple documents that match the query."
                ),
                Guideline(
                    "When using async iteration, don't use `.collect()` or `.take(n)` on the result of a query. Instead, use the `for await (const row of query)` syntax."
                ),
                GuidelineSection(
                    "ordering",
                    [
                        Guideline(
                            "By default Convex always returns documents in ascending `_creationTime` order."
                        ),
                        Guideline(
                            "You can use `.order('asc')` or `.order('desc')` to pick whether a query is in ascending or descending order. If the order isn't specified, it defaults to ascending."
                        ),
                        Guideline(
                            "Document queries that use indexes will be ordered based on the columns in the index and can avoid slow table scans."
                        ),
                    ],
                ),
            ],
        ),
        GuidelineSection(
            "mutation_guidelines",
            [
                Guideline(
                    "Use `ctx.db.replace` to fully replace an existing document. This method will throw an error if the document does not exist."
                ),
                Guideline(
                    "Use `ctx.db.patch` to shallow merge updates into an existing document. This method will throw an error if the document does not exist."
                ),
            ],
        ),
        GuidelineSection(
            "action_guidelines",
            [
                Guideline(
                    'Always add `"use node";` to the top of files containing actions that use Node.js built-in modules.'
                ),
                Guideline(
                    "Never use `ctx.db` inside of an action. Actions don't have access to the database."
                ),
                Guideline(
                    """Below is an example of the syntax for an action:
                    ```ts
                    import { action } from "./_generated/server";

                    export const exampleAction = action({
                        args: {},
                        returns: v.null(),
                        handler: async (ctx, args) => {
                            console.log("This action does not return anything");
                            return null;
                        },
                    });
                    ```
                    """
                ),
            ],
        ),
        GuidelineSection(
            "scheduling_guidelines",
            [
                GuidelineSection(
                    "cron_guidelines",
                    [
                        Guideline(
                            "Only use the `crons.interval` or `crons.cron` methods to schedule cron jobs. Do NOT use the `crons.hourly`, `crons.daily`, or `crons.weekly` helpers."
                        ),
                        Guideline(
                            "Both cron methods take in a FunctionReference. Do NOT try to pass the function directly into one of these methods."
                        ),
                        Guideline(
                            """Define crons by declaring the top-level `crons` object, calling some methods on it, and then exporting it as default. For example,
                            ```ts
                            import { cronJobs } from "convex/server";
                            import { internal } from "./_generated/api";
                            import { internalAction } from "./_generated/server";

                            const empty = internalAction({
                              args: {},
                              returns: v.null(),
                              handler: async (ctx, args) => {
                                console.log("empty");
                              },
                            });

                            const crons = cronJobs();

                            // Run `internal.crons.empty` every two hours.
                            crons.interval("delete inactive users", { hours: 2 }, internal.crons.empty, {});

                            export default crons;
                            ```
                            """
                        ),
                        Guideline(
                            "You can register Convex functions within `crons.ts` just like any other file."
                        ),
                        Guideline(
                            "If a cron calls an internal function, always import the `internal` object from '_generated/api`, even if the internal function is registered in the same file."
                        ),
                    ],
                ),
            ],
        ),
        GuidelineSection(
            "file_storage_guidelines",
            [
                Guideline(
                    "Convex includes file storage for large files like images, videos, and PDFs."
                ),
                Guideline(
                    "The `ctx.storage.getUrl()` method returns a signed URL for a given file. It returns `null` if the file doesn't exist."
                ),
                Guideline(
                    """
                    Do NOT use the deprecated `ctx.storage.getMetadata` call for loading a file's metadata.

                    Instead, query the `_storage` system table. For example, you can use `ctx.db.system.get` to get an `Id<"_storage">`.
                    ```
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
                        returns: v.null();
                        handler: async (ctx, args) => {
                            const metadata: FileMetadata | null = await ctx.db.system.get(args.fileId);
                            console.log(metadata);
                            return null;
                        },
                    });
                    ```
                    """
                ),
                Guideline(
                    "Convex storage stores items as `Blob` objects. You must convert all items to/from a `Blob` when using Convex storage."
                ),
            ],
        ),
    ],
)

if __name__ == "__main__":
    import sys
    import os
    from .model_codegen import OPENAI_CONVEX_GUIDELINES, render_examples as openai_render_examples

    outdir = sys.argv[1]

    os.makedirs(outdir, exist_ok=True)

    with open(os.path.join(outdir, "guidelines.md"), "w") as f:
        f.write(OPENAI_CONVEX_GUIDELINES)

    with open(os.path.join(outdir, "examples.md"), "w") as f:
        f.write("".join(openai_render_examples()))
