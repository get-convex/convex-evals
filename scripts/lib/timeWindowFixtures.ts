const indexed =
  'ctx.db.query("items").withIndex("by_expiresAt", q => q.gt("expiresAt", args.now))';

function source(body: string, extra = "", timeArgName = "now"): string {
  return `import { v } from "convex/values";
import { query, internalQuery, internalMutation, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
export const listActive = query({
  args: { ${timeArgName}: v.number() },
  handler: async (ctx, args): Promise<Doc<"items">[]> => { ${body} },
});
${extra}`;
}

function fixture(
  name: string,
  valid: boolean,
  body: string,
  extra = "",
  files: Record<string, string> = {},
  timeArgName = "now",
) {
  return {
    name,
    valid,
    timeArgName,
    files: { "convex/index.ts": source(body, extra, timeArgName), ...files },
  };
}

export const timeWindowFixtures = [
  fixture(
    "clock-in-empty-branch",
    false,
    `const rows = await ${indexed}.take(100); if (rows.length === 0) Date.now(); return rows;`,
  ),
  fixture(
    "clock-in-full-branch",
    false,
    `const rows = await ${indexed}.take(100); if (rows.length === 100) Date.now(); return rows;`,
  ),
  fixture("reference", true, `return await ${indexed}.take(100);`),
  fixture(
    "split-query-chain",
    true,
    `const activeItems = ${indexed}; return await activeItems.take(100);`,
  ),
  fixture(
    "late-constants-and-aliases",
    true,
    'const items = ctx.db.query(TABLE); const active = items.withIndex(INDEX, q => q.gt("expiresAt", args.now)); const alias = active; const rows = await alias.take(LIMIT); return rows;',
    'const TABLE = "items"; const INDEX = "by_expiresAt"; const LIMIT = 100;',
  ),
  fixture(
    "unrelated-mutation-clock",
    true,
    `return await ${indexed}.take(100);`,
    'export const unrelated = internalMutation({ args: {}, handler: async ctx => { const now = Date.now(); const rows = await ctx.db.query("items").collect(); return rows.filter(row => row.expiresAt > now).sort((a,b) => a.expiresAt-b.expiresAt).slice(0,100); } });',
  ),
  fixture(
    "unused-clock-helper",
    true,
    `return await ${indexed}.take(100);`,
    "function unusedClock() { return Date.now(); }",
  ),
  fixture(
    "local-query-helper",
    true,
    "return await read(ctx, args.now);",
    'async function read(ctx: QueryCtx, now: number) { const active = ctx.db.query("items").withIndex("by_expiresAt", q => q.gt("expiresAt", now)); return await active.take(100); }',
  ),
  fixture(
    "imported-query-helper",
    true,
    "return await read(ctx, args.now);",
    'import { read } from "./helpers";',
    {
      "convex/helpers.ts":
        'import type { QueryCtx } from "./_generated/server"; export function read(ctx: QueryCtx, now: number) { return ctx.db.query("items").withIndex("by_expiresAt", q => q.gt("expiresAt", now)).take(100); }',
    },
  ),
  fixture(
    "internal-query-helper",
    true,
    "return await ctx.runQuery(internal.index.readActive, args);",
    `export const readActive = internalQuery({ args: { now: v.number() }, handler: async (ctx,args) => ${indexed}.take(100) });`,
  ),
  fixture(
    "deterministic-date-conversion",
    true,
    'const cutoff = new Date(args.now).getTime(); return await ctx.db.query("items").withIndex("by_expiresAt", q => q.gt("expiresAt", cutoff)).take(100);',
  ),
  fixture(
    "renamed-time-argument",
    true,
    `return await ${indexed.replace("args.now", "args.cutoff")}.take(100);`,
    "",
    {},
    "cutoff",
  ),
  fixture("date-now", false, `Date.now(); return await ${indexed}.take(100);`),
  fixture("bare-date", false, `Date(); return await ${indexed}.take(100);`),
  fixture(
    "zero-argument-date",
    false,
    `new Date(); return await ${indexed}.take(100);`,
  ),
  fixture(
    "global-clock",
    false,
    `globalThis.Date.now(); return await ${indexed}.take(100);`,
  ),
  fixture(
    "aliased-clock",
    false,
    `const { now: clock } = Date; clock(); return await ${indexed}.take(100);`,
  ),
  fixture(
    "caught-clock-error",
    false,
    `try { Date.now(); } catch {} return await ${indexed}.take(100);`,
  ),
  fixture(
    "module-clock",
    false,
    `void captured; return await ${indexed}.take(100);`,
    "const captured = Date.now();",
  ),
  fixture(
    "local-clock-helper",
    false,
    `clock(); return await ${indexed}.take(100);`,
    "function clock() { return Date.now(); }",
  ),
  fixture(
    "imported-clock-helper",
    false,
    `clock(); return await ${indexed}.take(100);`,
    'import { clock } from "./helpers";',
    {
      "convex/helpers.ts": "export function clock() { return Date.now(); }",
    },
  ),
  fixture(
    "internal-clock-helper",
    false,
    "return await ctx.runQuery(internal.index.readActive, args);",
    `export const readActive = internalQuery({ args: { now: v.number() }, handler: async (ctx,args) => { Date.now(); return await ${indexed}.take(100); } });`,
  ),
  fixture("unbounded-collect", false, `return await ${indexed}.collect();`),
  fixture(
    "collect-then-slice",
    false,
    `return (await ${indexed}.collect()).slice(0,100);`,
  ),
  fixture(
    "unused-indexed-query",
    false,
    `${indexed}; return (await ctx.db.query("items").collect()).filter(row => row.expiresAt > args.now).sort((a,b) => a.expiresAt-b.expiresAt).slice(0,100);`,
  ),
  fixture(
    "database-filter",
    false,
    'return await ctx.db.query("items").withIndex("by_expiresAt").filter(q => q.gt(q.field("expiresAt"),args.now)).take(100);',
  ),
  fixture(
    "descending-then-sort",
    false,
    `return (await ${indexed}.order("desc").take(100)).sort((a,b) => a.expiresAt-b.expiresAt);`,
  ),
  fixture(
    "wrong-cutoff",
    false,
    `return await ${indexed.replace("args.now", "0")}.take(100);`,
  ),
  fixture(
    "inclusive-boundary",
    false,
    `return await ${indexed.replace("q.gt(", "q.gte(")}.take(100);`,
  ),
  fixture("disconnected-read", false, `await ${indexed}.take(100); return [];`),
];
