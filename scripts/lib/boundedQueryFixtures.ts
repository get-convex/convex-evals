const query = `ctx.db.query("auditLogs")
  .withIndex("by_workspaceId", (q) => q.eq("workspaceId", args.workspaceId))`;

function source(body: string, extra = ""): string {
  return `import { query, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { v } from "convex/values";
export const listAuditLogs = query({
  args: { workspaceId: v.string() },
  handler: async (ctx, args): Promise<Doc<"auditLogs">[]> => { ${body} },
});
${extra}`;
}

export const boundedQueryFixtures: {
  name: string;
  bounded: boolean;
  correct: boolean;
  files: Record<string, string>;
}[] = [];

function fixture(
  name: string,
  bounded: boolean,
  body: string,
  extra = "",
  correct = true,
): void {
  boundedQueryFixtures.push({
    name,
    bounded,
    correct,
    files: { "convex/index.ts": source(body, extra) },
  });
}

fixture(
  "take-1-ascending",
  true,
  `return await ${query}.order("asc").take(1);`,
);
fixture("take-25-default-order", true, `return await ${query}.take(25);`);
fixture(
  "bounded-point-refetch",
  true,
  `const rows = await ${query}.take(100); return await Promise.all(rows.map(async row => (await ctx.db.get("auditLogs", row._id))!));`,
);
fixture(
  "bounded-point-refetch-legacy",
  true,
  `const rows = await ${query}.take(100); return await Promise.all(rows.map(async row => (await ctx.db.get(row._id))!));`,
);
fixture(
  "take-250-descending",
  true,
  `return await ${query}.order("desc").take(250);`,
);
fixture(
  "aliased-query-and-late-constant",
  true,
  `const entries = ${query}; const fetchRows = () => entries.take(PAGE_SIZE); return await fetchRows();`,
  "const PAGE_SIZE = 17;",
);
fixture(
  "native-pagination-page",
  true,
  `const result = await ${query}.paginate({ numItems: 17, cursor: null }); return result.page;`,
);
fixture(
  "unrelated-internal-collect",
  true,
  `return await ${query}.take(25);`,
  `export const unused = internalQuery({ args: {}, handler: async (ctx) => ctx.db.query("auditLogs").collect() });`,
);
fixture(
  "unrelated-object-collect",
  true,
  `const diagnostics = { collect: () => "ok" }; diagnostics.collect(); return await ${query}.take(25);`,
);
fixture(
  "internal-query-helper",
  true,
  `return await ctx.runQuery(internal.index.readEntries, args);`,
  `export const readEntries = internalQuery({ args: { workspaceId: v.string() }, handler: async (ctx, args) => ${query}.take(25) });`,
);
for (const bounded of [true, false]) {
  const method = bounded ? "take(25)" : "collect()";
  boundedQueryFixtures.push({
    name: `imported-${bounded ? "bounded" : "unbounded"}-helper`,
    bounded,
    correct: true,
    files: {
      "convex/index.ts": source(
        "return await readEntries(ctx, args);",
        'import { readEntries } from "./helpers";',
      ),
      "convex/helpers.ts": `import type { QueryCtx } from "./_generated/server";
export async function readEntries(ctx: QueryCtx, args: { workspaceId: string }) { return await ${query}.${method}; }`,
    },
  });
}
fixture("collect", false, `return await ${query}.collect();`);
fixture(
  "collect-then-slice",
  false,
  `return (await ${query}.collect()).slice(0, 25);`,
);
fixture(
  "unbounded-iteration",
  false,
  `const rows = []; for await (const row of ${query}) rows.push(row); return rows;`,
);
fixture(
  "disconnected-bounded-read",
  false,
  `await ${query}.take(1); return await ${query}.collect();`,
);
fixture(
  "caught-unbounded-read",
  false,
  `try { await ${query}.collect(); } catch {} return await ${query}.take(25);`,
);
fixture("zero-bound", false, `return await ${query}.take(0);`, "", false);
fixture(
  "infinite-bound",
  false,
  `return await ${query}.take(Infinity);`,
  "",
  false,
);
fixture(
  "empty-after-bounded-read",
  false,
  `await ${query}.take(25); return [];`,
  "",
  false,
);
fixture(
  "global-take-before-filter",
  true,
  `return (await ctx.db.query("auditLogs").take(25)).filter((row) => row.workspaceId === args.workspaceId);`,
  "",
  false,
);
fixture(
  "wrong-workspace",
  true,
  `return await ctx.db.query("auditLogs").withIndex("by_workspaceId", (q) => q.eq("workspaceId", "workspace-before")).take(25);`,
  "",
  false,
);
fixture(
  "duplicate-results",
  true,
  `const rows = await ${query}.take(25); return rows.concat(rows);`,
  "",
  false,
);
fixture(
  "changed-document",
  true,
  `return (await ${query}.take(25)).map((row) => ({ ...row, action: "changed" }));`,
  "",
  false,
);
