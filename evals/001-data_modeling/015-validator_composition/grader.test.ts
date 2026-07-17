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
import { anyApi } from "convex/server";
import ts from "typescript";

const CATEGORY = "001-data_modeling";
const EVAL_NAME = "015-validator_composition";

beforeEach(async () => {
  await deleteAllDocuments(responseAdminClient, ["articles"]);
});

test("compare schema", async ({ skip }) => {
  await compareSchema(skip);
});

test("compare function spec", async ({ skip }) => {
  await compareFunctionSpec(skip, { ignoreReturns: true });
});

test("getArticle declares the extended response validator", async () => {
  const spec = (await responseAdminClient.query(
    "_system/cli/modules:apiSpec" as any,
    {},
  )) as { identifier: string; returns?: unknown }[];
  const entry = spec.find((f) => f.identifier === "index.js:getArticle");
  expect(entry, "getArticle must exist in convex/index.ts").toBeDefined();
  let returns = entry!.returns;
  if (typeof returns === "string") returns = JSON.parse(returns);
  const value = (returns as { value?: Record<string, unknown> })?.value ?? {};
  expect(
    Object.keys(value).sort(),
    "the return validator must be the full document extended with excerpt",
  ).toEqual(["_creationTime", "_id", "body", "excerpt", "slug", "title"]);
});

test("create, update, and get behave with derived shapes", async () => {
  const id = await responseClient.mutation(anyApi.index.createArticle, {
    title: "Hello World Post",
    body: "This body is long enough to have an excerpt cut from it.",
  });
  expect(id).toBeDefined();

  // Clients cannot supply the server-derived slug or system fields.
  await expect(
    responseClient.mutation(anyApi.index.createArticle, {
      title: "X",
      body: "Y",
      slug: "forged",
    }),
  ).rejects.toThrow();

  const stored = (await listTable(responseAdminClient, "articles", 10)) as {
    _id: string;
    title: string;
    body: string;
    slug: string;
  }[];
  expect(stored).toHaveLength(1);
  expect(stored[0].slug).toBe("hello-world-post");

  // Partial update: body only, slug unchanged.
  await responseClient.mutation(anyApi.index.updateArticle, {
    articleId: id,
    body: "New body content for the article.",
  });
  // Title update recomputes the slug.
  await responseClient.mutation(anyApi.index.updateArticle, {
    articleId: id,
    title: "Fresh Title",
  });
  // Immutable/unknown fields are rejected by the derived args validator.
  await expect(
    responseClient.mutation(anyApi.index.updateArticle, {
      articleId: id,
      slug: "forged",
    }),
  ).rejects.toThrow();

  const article = await responseClient.query(anyApi.index.getArticle, {
    articleId: id,
  });
  expect(article.title).toBe("Fresh Title");
  expect(article.slug).toBe("fresh-title");
  expect(article.excerpt).toBe("New body content for");
  expect(article.excerpt.length).toBe(20);
});

test("generated solution derives every shape from one base validator", () => {
  const source = readOutputFile(CATEGORY, EVAL_NAME, "convex/index.ts");
  const schemaSource = readOutputFile(CATEGORY, EVAL_NAME, "convex/schema.ts");
  const compose = new Set(["pick", "omit", "partial", "extend"]);

  const parse = (name: string, text: string) =>
    ts.createSourceFile(
      name,
      text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
  const indexFile = parse("index.ts", source);

  // baseVars: consts initialized with v.object(...). derivedVars: consts whose
  // initializer is a chain of composition methods rooted at a base or derived
  // var. Models may also compose inline at the use site, so the use-site
  // checks below accept anonymous chains rooted at a base/derived identifier.
  const baseVars = new Set<string>();
  const derivedVars = new Set<string>();

  let changed = true;
  while (changed) {
    changed = false;
    const visit = (node: ts.Node) => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer !== undefined
      ) {
        const name = node.name.text;
        const init = node.initializer;
        if (
          !baseVars.has(name) &&
          ts.isCallExpression(init) &&
          init.expression.getText() === "v.object"
        ) {
          baseVars.add(name);
          changed = true;
        }
        if (!derivedVars.has(name) && ts.isCallExpression(init)) {
          // Walk the chain down to its root identifier.
          let current: ts.Expression = init;
          const methods: string[] = [];
          while (
            ts.isCallExpression(current) &&
            ts.isPropertyAccessExpression(current.expression)
          ) {
            methods.push(current.expression.name.text);
            current = current.expression.expression;
          }
          if (
            methods.length > 0 &&
            methods.every((m) => compose.has(m)) &&
            ts.isIdentifier(current) &&
            (baseVars.has(current.text) || derivedVars.has(current.text))
          ) {
            derivedVars.add(name);
            changed = true;
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(indexFile);
  }

  expect(
    baseVars.size,
    "declare the base document validator with v.object",
  ).toBeGreaterThan(0);

  const derivedOrBase = new Set([...baseVars, ...derivedVars]);

  // Root of a composition chain: walk through compose calls and property
  // accesses (e.g. .fields) down to the leftmost expression.
  const chainRoot = (expr: ts.Expression): ts.Expression => {
    let current: ts.Expression = expr;
    for (;;) {
      if (ts.isPropertyAccessExpression(current)) {
        current = current.expression;
      } else if (
        ts.isCallExpression(current) &&
        ts.isPropertyAccessExpression(current.expression) &&
        compose.has(current.expression.name.text)
      ) {
        current = current.expression.expression;
      } else {
        break;
      }
    }
    return current;
  };

  // Count every distinct composition method applied to a base- or
  // derived-rooted chain anywhere in the module, named const or inline.
  const usedMethods = new Set<string>();
  const collectMethods = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      compose.has(node.expression.name.text)
    ) {
      const root = chainRoot(node.expression.expression);
      if (ts.isIdentifier(root) && derivedOrBase.has(root.text)) {
        usedMethods.add(node.expression.name.text);
      }
    }
    ts.forEachChild(node, collectMethods);
  };
  collectMethods(indexFile);
  expect(
    usedMethods.size,
    "use at least three distinct composition operations",
  ).toBeGreaterThanOrEqual(3);

  // A use site consumes a derivation when it references a derived const or
  // contains a composition chain rooted at a base/derived var. Hand-written
  // duplicate shapes contain neither and fail.
  const usesDerivation = (expression: ts.Expression): boolean => {
    let found = false;
    const scan = (node: ts.Node) => {
      if (found) return;
      if (ts.isIdentifier(node) && derivedVars.has(node.text)) {
        found = true;
        return;
      }
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        compose.has(node.expression.name.text)
      ) {
        const root = chainRoot(node.expression.expression);
        if (ts.isIdentifier(root) && derivedOrBase.has(root.text)) {
          found = true;
          return;
        }
      }
      ts.forEachChild(node, scan);
    };
    scan(expression);
    return found;
  };

  // The schema must consume a derived validator (an imported identifier or an
  // inline chain over one) rather than a duplicated shape.
  let schemaUsesDerived = false;
  const schemaFile = parse("schema.ts", schemaSource);
  const visitSchema = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText() === "defineTable" &&
      node.arguments.length >= 1
    ) {
      // Imports resolve by name, so accept any identifier-rooted argument.
      const root = chainRoot(node.arguments[0]);
      if (ts.isIdentifier(root)) schemaUsesDerived = true;
    }
    ts.forEachChild(node, visitSchema);
  };
  visitSchema(schemaFile);
  expect(
    schemaUsesDerived,
    "defineTable must consume the derived document validator, not a duplicated shape",
  ).toBe(true);

  let argsUseDerived = 0;
  let returnsUseDerived = 0;
  const visitRegs = (node: ts.Node) => {
    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      (node.name.text === "args" || node.name.text === "returns")
    ) {
      if (usesDerivation(node.initializer)) {
        if (node.name.text === "args") argsUseDerived++;
        else returnsUseDerived++;
      }
    }
    ts.forEachChild(node, visitRegs);
  };
  visitRegs(indexFile);
  expect(
    argsUseDerived,
    "at least two functions' args must consume derived validators",
  ).toBeGreaterThanOrEqual(2);
  expect(
    returnsUseDerived,
    "getArticle's returns must consume the derived response validator",
  ).toBeGreaterThanOrEqual(1);
});
