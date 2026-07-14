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
import { Doc, Id } from "./answer/convex/_generated/dataModel";
import ts from "typescript";

beforeEach(async () => {
  await deleteAllDocuments(responseAdminClient, ["scores"]);
});

// Insertion order matters: each row is added in its own mutation so that
// every document gets a distinct _creationTime. The three 100-point rows
// are interleaved with other scores so that tie order != insertion position.
const SEED: { player: string; points: number }[] = [
  { player: "oldest-100", points: 100 },
  { player: "fifty", points: 50 },
  { player: "middle-100", points: 100 },
  { player: "seventyfive", points: 75 },
  { player: "ninety", points: 90 },
  { player: "newest-100", points: 100 },
  { player: "twentyfive", points: 25 },
];

async function seedScores(): Promise<Map<string, Id<"scores">>> {
  for (const row of SEED) {
    await addDocuments(responseAdminClient, "scores", [row]);
  }
  const docs = (await listTable(
    responseAdminClient,
    "scores",
  )) as Doc<"scores">[];
  return new Map(docs.map((d) => [d.player, d._id]));
}

test("compare schema", async ({ skip }) => {
  await compareSchema(skip);
});

test("compare function spec", async ({ skip }) => {
  // Return validators are not required by the task, so ignore them.
  await compareFunctionSpec(skip, { ignoreReturns: true });
});

test("returns top n by points descending with newest-first ties", async () => {
  const ids = await seedScores();

  const result = (await responseClient.query(api.index.topScores, {
    n: 4,
  })) as Doc<"scores">[];

  // 100s newest-first, then 90. Any of the classic wrong implementations
  // (ascending take+reverse, take+sort, collect+sort+slice, oldest-first
  // ties) produces a different sequence.
  expect(result.map((d) => d._id)).toEqual([
    ids.get("newest-100"),
    ids.get("middle-100"),
    ids.get("oldest-100"),
    ids.get("ninety"),
  ]);
});

test("returns a single top score", async () => {
  const ids = await seedScores();

  const result = (await responseClient.query(api.index.topScores, {
    n: 1,
  })) as Doc<"scores">[];

  expect(result.map((d) => d._id)).toEqual([ids.get("newest-100")]);
});

test("returns the whole table in order when n exceeds the row count", async () => {
  const ids = await seedScores();

  const result = (await responseClient.query(api.index.topScores, {
    n: 100,
  })) as Doc<"scores">[];

  expect(result.map((d) => d._id)).toEqual([
    ids.get("newest-100"),
    ids.get("middle-100"),
    ids.get("oldest-100"),
    ids.get("ninety"),
    ids.get("seventyfive"),
    ids.get("fifty"),
    ids.get("twentyfive"),
  ]);
});

test("returned documents include the expected fields", async () => {
  await seedScores();

  const result = (await responseClient.query(api.index.topScores, {
    n: 2,
  })) as Doc<"scores">[];

  expect(result).toHaveLength(2);
  for (const doc of result) {
    expect(doc).toHaveProperty("_id");
    expect(doc).toHaveProperty("_creationTime");
    expect(doc.player).toBeTypeOf("string");
    expect(doc.points).toBeTypeOf("number");
  }
});

function analyzeSource(sourceText: string): {
  disallowedCalls: string[];
  hasDescIndexedTakeChain: boolean;
} {
  const sourceFile = ts.createSourceFile(
    "index.ts",
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const disallowed = new Set(["collect", "sort", "toSorted", "reverse"]);
  const disallowedCalls: string[] = [];
  let hasDescIndexedTakeChain = false;

  // Walk a method chain like ctx.db.query(...).withIndex(...).order(...)
  // .take(...) from its outermost call inward, collecting each method name
  // and its first argument when it is a string literal.
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
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression)
    ) {
      const name = node.expression.name.text;
      if (disallowed.has(name)) {
        disallowedCalls.push(name);
      }
      if (name === "take") {
        // The consumed chain itself must query the scores table through the
        // by_points index in descending order; a dead .order("desc") chain
        // elsewhere doesn't count.
        const parts = chainParts(node);
        const has = (n: string, arg?: string) =>
          parts.some(
            (p) => p.name === n && (arg === undefined || p.firstStringArg === arg),
          );
        if (
          has("query", "scores") &&
          has("withIndex", "by_points") &&
          has("order", "desc")
        ) {
          hasDescIndexedTakeChain = true;
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return { disallowedCalls, hasDescIndexedTakeChain };
}

test("generated solution reads in database index order instead of re-sorting", () => {
  const sourceText = readOutputFile(
    "002-queries",
    "025-ordering_tiebreak",
    "convex/index.ts",
  );
  const { disallowedCalls, hasDescIndexedTakeChain } =
    analyzeSource(sourceText);
  expect(disallowedCalls).toEqual([]);
  expect(hasDescIndexedTakeChain).toBe(true);
});
