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
  probeValid = true,
) {
  return {
    name,
    valid,
    probeValid,
    timeArgName,
    files: { "convex/index.ts": source(body, extra, timeArgName), ...files },
  };
}

// The execution probe owns only the no-clock rule. Real-backend behavior tests
// separately reject wrong cutoffs, ordering, caps, and disconnected results.
function clockFixture(
  name: string,
  body: string,
  extra = "",
  files: Record<string, string> = {},
) {
  return fixture(name, false, body, extra, files, "now", false);
}

const temporalDeclaration = `declare const Temporal: {
  Now: {
    instant(this: void): { epochMilliseconds: number };
    plainDateTimeISO(): unknown;
    zonedDateTimeISO(): unknown;
    plainDateISO(): unknown;
    plainTimeISO(): unknown;
    timeZoneId(): string;
  };
  Instant: { fromEpochMilliseconds(value: number): { epochMilliseconds: number } };
};`;

export const timeWindowFixtures = [
  ...[
    "instant",
    "plainDateTimeISO",
    "zonedDateTimeISO",
    "plainDateISO",
    "plainTimeISO",
  ].map((method) =>
    clockFixture(
      `temporal-now-${method}`,
      `Temporal.Now.${method}(); return await ${indexed}.take(100);`,
      temporalDeclaration,
    ),
  ),
  clockFixture(
    "temporal-now-alias",
    `const { instant } = Temporal.Now; instant(); return await ${indexed}.take(100);`,
    temporalDeclaration,
  ),
  clockFixture(
    "temporal-now-descriptor",
    `(Object.getOwnPropertyDescriptor(Temporal.Now, "instant")!.value as () => unknown)(); return await ${indexed}.take(100);`,
    temporalDeclaration,
  ),
  fixture(
    "temporal-explicit-instant-and-timezone",
    true,
    `Temporal.Now.timeZoneId(); const cutoff = Temporal.Instant.fromEpochMilliseconds(args.now).epochMilliseconds; return await ${indexed.replace("args.now", "cutoff")}.take(100);`,
    temporalDeclaration,
  ),
  clockFixture(
    "intl-default-format",
    `new Intl.DateTimeFormat("en").format(); return await ${indexed}.take(100);`,
  ),
  clockFixture(
    "intl-undefined-format",
    `new Intl.DateTimeFormat("en").format(undefined); return await ${indexed}.take(100);`,
  ),
  clockFixture(
    "intl-default-parts",
    `new Intl.DateTimeFormat("en").formatToParts(); return await ${indexed}.take(100);`,
  ),
  clockFixture(
    "intl-format-descriptor",
    `const formatter = new Intl.DateTimeFormat("en"); const getFormat = Object.getOwnPropertyDescriptor(Intl.DateTimeFormat.prototype, "format")!.get!.bind(formatter) as () => (date?: number) => string; getFormat()(); return await ${indexed}.take(100);`,
  ),
  fixture(
    "intl-explicit-timestamps",
    true,
    `const formatter = new Intl.DateTimeFormat("en"); if (formatter.format !== formatter.format) throw new Error("Bound formatter identity changed"); formatter.format(args.now); formatter.formatToParts(args.now); const getFormat = Object.getOwnPropertyDescriptor(Intl.DateTimeFormat.prototype, "format")!.get!.bind(formatter) as () => (date?: number) => string; getFormat()(args.now); return await ${indexed}.take(100);`,
  ),
  clockFixture(
    "performance-time-origin",
    `void performance.timeOrigin; return await ${indexed}.take(100);`,
  ),
  clockFixture(
    "performance-origin-descriptor",
    `const origin = Object.getOwnPropertyDescriptor(Performance.prototype, "timeOrigin")!.get!.bind(performance) as () => number; origin(); return await ${indexed}.take(100);`,
  ),
  clockFixture(
    "performance-to-json",
    `performance.toJSON(); return await ${indexed}.take(100);`,
  ),
  clockFixture(
    "performance-to-json-alias",
    `const asJSON = performance.toJSON.bind(performance); asJSON(); return await ${indexed}.take(100);`,
  ),
  fixture(
    "performance-duration-only",
    true,
    `const start = performance.now(); const rows = await ${indexed}.take(100); console.log(performance.now() - start); return rows;`,
  ),
  fixture(
    "bounded-async-iteration",
    true,
    `const rows = []; for await (const row of ${indexed}) { rows.push(row); if (rows.length === 100) break; } return rows;`,
  ),
  fixture(
    "native-pagination-page",
    true,
    `const result = await ${indexed}.paginate({ numItems: 100, cursor: null }); return result.page;`,
  ),
  fixture(
    "pagination-point-refetch",
    true,
    `const result = await ${indexed}.paginate({ numItems: 100, cursor: null }); return await Promise.all(result.page.map(async row => (await ctx.db.get("items", row._id))!));`,
  ),
  fixture(
    "pagination-wrong-cutoff",
    false,
    `const result = await ${indexed.replace("args.now", "0")}.paginate({ numItems: 100, cursor: null }); return result.page;`,
  ),
  fixture(
    "pagination-database-filter",
    true,
    `const result = await ctx.db.query("items").withIndex("by_expiresAt").filter(q => q.gt(q.field("expiresAt"), args.now)).paginate({ numItems: 100, cursor: null }); return result.page;`,
  ),
  clockFixture(
    "pagination-clock-read",
    `const result = await ${indexed}.paginate({ numItems: 100, cursor: null }); Date.now(); return result.page;`,
  ),
  fixture(
    "pagination-disconnected-read",
    false,
    `await ${indexed}.paginate({ numItems: 100, cursor: null }); return [];`,
  ),
  fixture(
    "bounded-point-refetch",
    true,
    `const rows = await ${indexed}.take(100); return await Promise.all(rows.map(async row => (await ctx.db.get("items", row._id))!));`,
  ),
  fixture(
    "bounded-point-refetch-legacy",
    true,
    `const rows = await ${indexed}.take(100); return await Promise.all(rows.map(async row => (await ctx.db.get(row._id))!));`,
  ),
  clockFixture(
    "clock-during-refetch",
    `const rows = await ${indexed}.take(100); return await Promise.all(rows.map(async row => { const doc = await ctx.db.get("items", row._id); Date.now(); return doc!; }));`,
  ),
  clockFixture(
    "prototype-constructor-clock",
    `(Date.prototype.constructor as typeof Date).now(); return await ${indexed}.take(100);`,
  ),
  clockFixture(
    "instance-constructor-clock",
    `(new Date(0).constructor as typeof Date).now(); return await ${indexed}.take(100);`,
  ),
  clockFixture(
    "prototype-constructor-no-args",
    `const Clock = Date.prototype.constructor as typeof Date; new Clock(); return await ${indexed}.take(100);`,
  ),
  clockFixture(
    "clock-method-descriptor",
    `(Object.getOwnPropertyDescriptor(Date, "now")!.value as () => number)(); return await ${indexed}.take(100);`,
  ),
  fixture(
    "deterministic-constructor-alias",
    true,
    `const Clock = new Date(0).constructor as typeof Date; const cutoff = new Clock(args.now).getTime(); return await ${indexed.replace("args.now", "cutoff")}.take(100);`,
  ),
  fixture(
    "deterministic-date-statics",
    true,
    `Date.UTC(2020, 0, 1); const cutoff = Date.parse(new Date(args.now).toISOString()); return await ${indexed.replace("args.now", "cutoff")}.take(100);`,
  ),
  clockFixture(
    "clock-in-empty-branch",
    `const rows = await ${indexed}.take(100); if (rows.length === 0) Date.now(); return rows;`,
  ),
  clockFixture(
    "clock-in-full-branch",
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
  clockFixture("date-now", `Date.now(); return await ${indexed}.take(100);`),
  clockFixture("bare-date", `Date(); return await ${indexed}.take(100);`),
  clockFixture(
    "zero-argument-date",
    `new Date(); return await ${indexed}.take(100);`,
  ),
  clockFixture(
    "global-clock",
    `globalThis.Date.now(); return await ${indexed}.take(100);`,
  ),
  clockFixture(
    "aliased-clock",
    `const { now: clock } = Date; clock(); return await ${indexed}.take(100);`,
  ),
  clockFixture(
    "caught-clock-error",
    `try { Date.now(); } catch {} return await ${indexed}.take(100);`,
  ),
  clockFixture(
    "module-clock",
    `void captured; return await ${indexed}.take(100);`,
    "const captured = Date.now();",
  ),
  clockFixture(
    "local-clock-helper",
    `clock(); return await ${indexed}.take(100);`,
    "function clock() { return Date.now(); }",
  ),
  clockFixture(
    "imported-clock-helper",
    `clock(); return await ${indexed}.take(100);`,
    'import { clock } from "./helpers";',
    {
      "convex/helpers.ts": "export function clock() { return Date.now(); }",
    },
  ),
  clockFixture(
    "internal-clock-helper",
    "return await ctx.runQuery(internal.index.readActive, args);",
    `export const readActive = internalQuery({ args: { now: v.number() }, handler: async (ctx,args) => { Date.now(); return await ${indexed}.take(100); } });`,
  ),
  fixture("unbounded-collect", false, `return await ${indexed}.collect();`),
  fixture(
    "collect-then-slice",
    true,
    `return (await ${indexed}.collect()).slice(0,100);`,
  ),
  fixture(
    "unused-indexed-query",
    true,
    `${indexed}; return (await ctx.db.query("items").collect()).filter(row => row.expiresAt > args.now).sort((a,b) => a.expiresAt-b.expiresAt).slice(0,100);`,
  ),
  fixture(
    "database-filter",
    true,
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
