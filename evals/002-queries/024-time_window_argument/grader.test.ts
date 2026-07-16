import { expect, test, beforeEach } from "vitest";
import {
  addDocuments,
  compareSchema,
  deleteAllDocuments,
  listTable,
  readOutputFile,
  responseAdminClient,
  responseClient,
} from "../../../grader";
import { anyApi } from "convex/server";
import { Doc } from "./answer/convex/_generated/dataModel";
import ts from "typescript";

const NOW = 1_700_000_000_000;

beforeEach(async () => {
  await deleteAllDocuments(responseAdminClient, ["items"]);
});

/**
 * The task deliberately does not dictate the query's arguments: choosing to
 * take the current time as a caller-supplied argument (rather than reading
 * the wall clock) IS the concept under test. Discover the numeric argument
 * the solution declared - whatever it is named - and drive every behavioral
 * test through it.
 */
async function getTimeArgName(): Promise<string> {
  const spec = (await responseAdminClient.query(
    "_system/cli/modules:apiSpec" as any,
    {},
  )) as any[];
  const entry = spec.find((f: any) => f.identifier === "index.js:listActive");
  expect(entry, "listActive is not defined in convex/index.ts").toBeDefined();
  expect(entry.functionType).toBe("Query");
  expect(entry.visibility?.kind).toBe("public");

  let args = entry.args;
  if (typeof args === "string") {
    args = JSON.parse(args);
  }
  expect(
    args?.type,
    "listActive must declare an arguments object",
  ).toBe("object");
  const fields = Object.entries(args.value ?? {}) as [string, any][];
  const numericFields = fields.filter(([, field]) =>
    ["number", "float64"].includes(field?.fieldType?.type),
  );
  expect(
    numericFields,
    "listActive must take exactly one caller-supplied numeric (timestamp) argument",
  ).toHaveLength(1);
  const otherRequired = fields.filter(
    ([name, field]) => name !== numericFields[0][0] && !field?.optional,
  );
  expect(
    otherRequired,
    "listActive must not require arguments beyond its timestamp",
  ).toHaveLength(0);
  return numericFields[0][0];
}

async function listActive(now: number): Promise<Doc<"items">[]> {
  const argName = await getTimeArgName();
  return (await responseClient.query(anyApi.index.listActive, {
    [argName]: now,
  })) as Doc<"items">[];
}

test("compare schema", async ({ skip }) => {
  await compareSchema(skip);
});

test("declares a caller-supplied timestamp argument", async () => {
  const argName = await getTimeArgName();
  expect(argName).toBeTruthy();
});

test("strict boundary: only items expiring after the supplied time, soonest first", async () => {
  // Inserted deliberately out of expiration order.
  await addDocuments(responseAdminClient, "items", [
    { name: "later", expiresAt: NOW + 2000 },
    { name: "past", expiresAt: NOW - 5000 },
    { name: "soon", expiresAt: NOW + 1000 },
    { name: "boundary", expiresAt: NOW },
  ]);

  const results = await listActive(NOW);

  // "boundary" (expiresAt === now) is excluded: strictly greater only.
  expect(results.map((r) => r.name)).toEqual(["soon", "later"]);
});

test("the cutoff really comes from the argument", async () => {
  // Same seed, different supplied times must produce different windows - an
  // implementation that ignores its argument cannot pass all three.
  await addDocuments(responseAdminClient, "items", [
    { name: "later", expiresAt: NOW + 2000 },
    { name: "past", expiresAt: NOW - 5000 },
    { name: "soon", expiresAt: NOW + 1000 },
  ]);

  const midWindow = await listActive(NOW + 1500);
  expect(midWindow.map((r) => r.name)).toEqual(["later"]);

  const wideWindow = await listActive(NOW - 6000);
  expect(wideWindow.map((r) => r.name)).toEqual(["past", "soon", "later"]);

  const emptyWindow = await listActive(NOW + 3000);
  expect(emptyWindow).toEqual([]);
});

test("returns at most 100 items, the soonest-expiring ones", async () => {
  const items = Array.from({ length: 105 }, (_, i) => ({
    name: `item-${i + 1}`,
    expiresAt: NOW + (i + 1) * 10,
  }));
  await addDocuments(responseAdminClient, "items", items);
  const seeded = (await listTable(
    responseAdminClient,
    "items",
    200,
  )) as Doc<"items">[];
  expect(seeded).toHaveLength(105);

  const results = await listActive(NOW);

  expect(results).toHaveLength(100);
  expect(results.map((r) => r.name)).toEqual(
    Array.from({ length: 100 }, (_, i) => `item-${i + 1}`),
  );
  for (let i = 1; i < results.length; i++) {
    expect(results[i - 1].expiresAt).toBeLessThanOrEqual(results[i].expiresAt);
  }
});

test("returns an empty array when everything has expired", async () => {
  await addDocuments(responseAdminClient, "items", [
    { name: "old-1", expiresAt: NOW - 1000 },
    { name: "old-2", expiresAt: NOW - 2000 },
  ]);

  const results = await listActive(NOW);

  expect(results).toEqual([]);
});

function analyzeSource(sourceText: string): {
  wallClockReads: string[];
  disallowedCalls: string[];
  hasIndexedTakeChain: boolean;
} {
  const sourceFile = ts.createSourceFile(
    "index.ts",
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const wallClockReads: string[] = [];
  // The task only asks for a single query, so the whole file must stay off
  // the wall clock; a source-wide check also catches helper functions and
  // module-level reads that a handler-scoped walk would miss.
  const isDateRef = (expr: ts.Expression): boolean => {
    if (ts.isIdentifier(expr) && expr.text === "Date") return true;
    // globalThis.Date / window.Date
    return (
      ts.isPropertyAccessExpression(expr) &&
      expr.name.text === "Date" &&
      ts.isIdentifier(expr.expression) &&
      (expr.expression.text === "globalThis" || expr.expression.text === "window")
    );
  };

  // A correct solution expresses the whole predicate in the index range and
  // bounds the result; these constructs indicate scanning or re-sorting.
  const disallowed = new Set(["collect", "filter", "sort", "toSorted", "slice"]);
  const disallowedCalls: string[] = [];
  let hasIndexedTakeChain = false;

  const chainParts = (
    call: ts.CallExpression,
  ): { name: string; firstStringArg?: string }[] => {
    const parts: { name: string; firstStringArg?: string }[] = [];
    let current: ts.Expression = call;
    while (
      ts.isCallExpression(current) &&
      ts.isPropertyAccessExpression(current.expression)
    ) {
      const arg = current.arguments[0];
      parts.push({
        name: current.expression.name.text,
        firstStringArg:
          arg !== undefined && ts.isStringLiteralLike(arg)
            ? arg.text
            : undefined,
      });
      current = current.expression.expression;
    }
    return parts;
  };

  const visit = (node: ts.Node) => {
    // Date.now(), globalThis.Date.now()
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "now" &&
      isDateRef(node.expression.expression)
    ) {
      wallClockReads.push("Date.now()");
    }
    // Bare Date() call - returns the current time as a string.
    if (ts.isCallExpression(node) && isDateRef(node.expression)) {
      wallClockReads.push("Date()");
    }
    // new Date() with no arguments; new Date(value) is a deterministic
    // conversion and stays allowed.
    if (
      ts.isNewExpression(node) &&
      isDateRef(node.expression) &&
      (node.arguments === undefined || node.arguments.length === 0)
    ) {
      wallClockReads.push("new Date()");
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression)
    ) {
      const name = node.expression.name.text;
      if (disallowed.has(name)) {
        disallowedCalls.push(name);
      }
      if (name === "take") {
        const parts = chainParts(node);
        const has = (n: string, arg?: string) =>
          parts.some(
            (p) => p.name === n && (arg === undefined || p.firstStringArg === arg),
          );
        if (has("query", "items") && has("withIndex", "by_expiresAt")) {
          hasIndexedTakeChain = true;
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return { wallClockReads, disallowedCalls, hasIndexedTakeChain };
}

test("generated solution uses an indexed bounded read and never the wall clock", () => {
  const sourceText = readOutputFile(
    "002-queries",
    "024-time_window_argument",
    "convex/index.ts",
  );
  const { wallClockReads, disallowedCalls, hasIndexedTakeChain } =
    analyzeSource(sourceText);
  expect(wallClockReads).toEqual([]);
  expect(disallowedCalls).toEqual([]);
  expect(hasIndexedTakeChain).toBe(true);
});
