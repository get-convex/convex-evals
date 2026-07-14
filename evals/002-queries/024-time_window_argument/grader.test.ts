import { expect, test, beforeEach } from "vitest";
import {
  addDocuments,
  compareFunctionSpec,
  compareSchema,
  deleteAllDocuments,
  listTable,
  readOutputFile,
  responseAdminClient,
  responseClient,
} from "../../../grader";
import { api } from "./answer/convex/_generated/api";
import { Doc } from "./answer/convex/_generated/dataModel";
import ts from "typescript";

const NOW = 1_700_000_000_000;

beforeEach(async () => {
  await deleteAllDocuments(responseAdminClient, ["items"]);
});

test("compare schema", async ({ skip }) => {
  await compareSchema(skip);
});

test("compare function spec", async ({ skip }) => {
  // Return validators are not required by the task, so ignore them.
  await compareFunctionSpec(skip, { ignoreReturns: true });
});

test("strict boundary: only items expiring after `now`, soonest first", async () => {
  // Inserted deliberately out of expiration order.
  await addDocuments(responseAdminClient, "items", [
    { name: "later", expiresAt: NOW + 2000 },
    { name: "past", expiresAt: NOW - 5000 },
    { name: "soon", expiresAt: NOW + 1000 },
    { name: "boundary", expiresAt: NOW },
  ]);

  const results = (await responseClient.query(api.index.listActive, {
    now: NOW,
  })) as Doc<"items">[];

  // "boundary" (expiresAt === now) is excluded: strictly greater only.
  expect(results.map((r) => r.name)).toEqual(["soon", "later"]);
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

  const results = (await responseClient.query(api.index.listActive, {
    now: NOW,
  })) as Doc<"items">[];

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

  const results = (await responseClient.query(api.index.listActive, {
    now: NOW,
  })) as Doc<"items">[];

  expect(results).toEqual([]);
});

function queryHandlersReadWallClock(sourceText: string): boolean {
  const sourceFile = ts.createSourceFile(
    "index.ts",
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  let found = false;

  const containsWallClockRead = (node: ts.Node): void => {
    // Date.now()
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "now" &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "Date"
    ) {
      found = true;
      return;
    }
    // new Date() with no arguments; new Date(value) is a deterministic
    // conversion and stays allowed.
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "Date" &&
      (node.arguments === undefined || node.arguments.length === 0)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, containsWallClockRead);
  };

  // Scope the check to handlers of query()/internalQuery() registrations;
  // Date.now() is valid in mutations and actions.
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      (node.expression.text === "query" ||
        node.expression.text === "internalQuery") &&
      node.arguments.length === 1 &&
      ts.isObjectLiteralExpression(node.arguments[0])
    ) {
      for (const prop of node.arguments[0].properties) {
        if (
          ts.isPropertyAssignment(prop) &&
          ts.isIdentifier(prop.name) &&
          prop.name.text === "handler"
        ) {
          containsWallClockRead(prop.initializer);
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return found;
}

test("generated solution does not read the wall clock inside a query", () => {
  const sourceText = readOutputFile(
    "002-queries",
    "024-time_window_argument",
    "convex/index.ts",
  );
  expect(queryHandlersReadWallClock(sourceText)).toBe(false);
});
