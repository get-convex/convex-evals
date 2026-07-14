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
  await deleteAllDocuments(responseAdminClient, ["documents"]);
});

// Cosine similarities against the query vector [1, 0, 0, 0]:
//   exact-guide  1.00
//   draft-close  ~0.95 (excluded from results by status during hydration)
//   near-guide   0.80
//   mid-guide    0.50
//   far-guide    0.00
//   blog-exact   1.00 (excluded from "guides" searches by the vector filter)
const SEED: {
  title: string;
  category: string;
  status: string;
  embedding: number[];
}[] = [
  { title: "exact-guide", category: "guides", status: "published", embedding: [1, 0, 0, 0] },
  { title: "near-guide", category: "guides", status: "published", embedding: [0.8, 0.6, 0, 0] },
  { title: "mid-guide", category: "guides", status: "published", embedding: [0.5, 0.5, 0.5, 0.5] },
  { title: "far-guide", category: "guides", status: "published", embedding: [0, 1, 0, 0] },
  { title: "draft-close", category: "guides", status: "draft", embedding: [0.95, 0.31, 0, 0] },
  { title: "blog-exact", category: "blog", status: "published", embedding: [1, 0, 0, 0] },
];

const QUERY_VECTOR = [1, 0, 0, 0];

async function seedDocuments(): Promise<Map<string, Id<"documents">>> {
  await addDocuments(responseAdminClient, "documents", SEED);
  const docs = (await listTable(
    responseAdminClient,
    "documents",
  )) as Doc<"documents">[];
  return new Map(docs.map((d) => [d.title, d._id]));
}

test("compare schema", async ({ skip }) => {
  await compareSchema(skip);
});

test("compare function spec", async ({ skip }) => {
  // Return validators are not required by the task, so ignore them.
  await compareFunctionSpec(skip, { ignoreReturns: true });
});

test("returns published category matches in descending similarity order", async () => {
  const ids = await seedDocuments();

  const results = await responseClient.action(api.index.searchDocuments, {
    embedding: QUERY_VECTOR,
    category: "guides",
    limit: 10,
  });

  expect(results.map((r: { _id: string }) => r._id)).toEqual([
    ids.get("exact-guide"),
    ids.get("near-guide"),
    ids.get("mid-guide"),
    ids.get("far-guide"),
  ]);
  for (let i = 1; i < results.length; i++) {
    expect(results[i - 1]._score).toBeGreaterThanOrEqual(results[i]._score);
  }
  for (const result of results) {
    expect(result.status).toBe("published");
    expect(result._score).toBeTypeOf("number");
  }
});

test("returned objects have exactly the specified fields", async () => {
  await seedDocuments();

  const results = await responseClient.action(api.index.searchDocuments, {
    embedding: QUERY_VECTOR,
    category: "guides",
    limit: 10,
  });

  expect(results.length).toBeGreaterThan(0);
  for (const result of results) {
    expect(Object.keys(result).sort()).toEqual([
      "_id",
      "_score",
      "category",
      "status",
      "title",
    ]);
  }
});

test("unpublished documents consume vector hits but are omitted", async () => {
  const ids = await seedDocuments();

  // The top two vector hits for "guides" are exact-guide (1.0) and
  // draft-close (~0.95). With limit 2 the draft is dropped during
  // hydration, so only one result comes back.
  const results = await responseClient.action(api.index.searchDocuments, {
    embedding: QUERY_VECTOR,
    category: "guides",
    limit: 2,
  });

  expect(results.map((r: { _id: string }) => r._id)).toEqual([
    ids.get("exact-guide"),
  ]);
});

test("category filter is applied in the vector search", async () => {
  const ids = await seedDocuments();

  const results = await responseClient.action(api.index.searchDocuments, {
    embedding: QUERY_VECTOR,
    category: "blog",
    limit: 10,
  });

  expect(results.map((r: { _id: string }) => r._id)).toEqual([
    ids.get("blog-exact"),
  ]);
});

test("unknown category returns no results", async () => {
  await seedDocuments();

  const results = await responseClient.action(api.index.searchDocuments, {
    embedding: QUERY_VECTOR,
    category: "missing",
    limit: 10,
  });

  expect(results).toEqual([]);
});

function analyzeSource(sourceText: string): {
  hasVectorSearch: boolean;
  runQueryCount: number;
  runQueryInLoop: boolean;
} {
  const sourceFile = ts.createSourceFile(
    "index.ts",
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  let hasVectorSearch = false;
  let runQueryCount = 0;
  let runQueryInLoop = false;

  const isInsideLoopOrIterationCallback = (node: ts.Node): boolean => {
    const iterationCallbacks = new Set(["map", "forEach", "flatMap"]);
    let current: ts.Node | undefined = node.parent;
    while (current !== undefined) {
      if (ts.isIterationStatement(current, false)) {
        return true;
      }
      if (
        ts.isCallExpression(current) &&
        ts.isPropertyAccessExpression(current.expression) &&
        iterationCallbacks.has(current.expression.name.text)
      ) {
        return true;
      }
      current = current.parent;
    }
    return false;
  };

  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression)
    ) {
      const name = node.expression.name.text;
      if (name === "vectorSearch") {
        hasVectorSearch = true;
      }
      if (name === "runQuery") {
        runQueryCount++;
        if (isInsideLoopOrIterationCallback(node)) {
          runQueryInLoop = true;
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return { hasVectorSearch, runQueryCount, runQueryInLoop };
}

test("generated solution uses vector search and a single hydration query", () => {
  const sourceText = readOutputFile(
    "004-actions",
    "008-vector_search_hydration",
    "convex/index.ts",
  );
  const { hasVectorSearch, runQueryCount, runQueryInLoop } =
    analyzeSource(sourceText);
  // Without ctx.vectorSearch, similarity scores would have to be computed
  // by scanning the table in JavaScript.
  expect(hasVectorSearch).toBe(true);
  // The task requires one internal query for hydration, not one per hit.
  expect(runQueryCount).toBe(1);
  expect(runQueryInLoop).toBe(false);
});
