import { beforeEach, expect, test } from "vitest";
import {
  compareFunctionSpec,
  compareSchema,
  deleteAllDocuments,
  getLatestOutputProjectDir,
  listTable,
  responseAdminClient,
  responseClient,
} from "../../../grader";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
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
  await compareFunctionSpec(skip, { ignoreReturns: true, publicOnly: true });
});

test("getArticle declares the complete document plus excerpt", async () => {
  const spec = (await responseAdminClient.query(
    "_system/cli/modules:apiSpec" as any,
    {},
  )) as { identifier: string; returns?: unknown }[];
  const entry = spec.find(
    (candidate) => candidate.identifier === "index.js:getArticle",
  );
  expect(entry, "getArticle must exist in convex/index.ts").toBeDefined();

  let returns = entry!.returns;
  if (typeof returns === "string") returns = JSON.parse(returns);
  const field = (fieldType: Record<string, unknown>) => ({
    fieldType,
    optional: false,
  });
  expect(returns).toEqual({
    type: "object",
    value: {
      _id: field({ type: "id", tableName: "articles" }),
      _creationTime: field({ type: "number" }),
      title: field({ type: "string" }),
      body: field({ type: "string" }),
      slug: field({ type: "string" }),
      excerpt: field({ type: "string" }),
    },
  });
});

test("create, update, and get behave with the composed validators", async () => {
  const id = await responseClient.mutation(anyApi.index.createArticle, {
    title: "Hello World Post",
    body: "This body is long enough to have an excerpt cut from it.",
  });
  expect(id).toBeDefined();

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

  await responseClient.mutation(anyApi.index.updateArticle, {
    articleId: id,
    body: "New body content for the article.",
  });
  await responseClient.mutation(anyApi.index.updateArticle, {
    articleId: id,
    title: "Fresh Title",
  });
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
});

test("application fields are declared once and every function shape is derived", () => {
  const convexDir = join(
    getLatestOutputProjectDir(CATEGORY, EVAL_NAME),
    "convex",
  );
  const files = authoredTypeScriptFiles(convexDir);
  const sources = new Map(
    files.map((file) => [
      file.relativePath,
      ts.createSourceFile(
        file.relativePath,
        readFileSync(file.absolutePath, "utf8"),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      ),
    ]),
  );
  const validators = sources.get("validators.ts");
  const schema = sources.get("schema.ts");
  const index = sources.get("index.ts");
  expect(validators, "create convex/validators.ts").toBeDefined();
  expect(schema, "create convex/schema.ts").toBeDefined();
  expect(index, "create convex/index.ts").toBeDefined();

  expectBaseValidator(validators!);
  expectSingleFieldDeclarations(sources);
  expectSchemaUsesBase(schema!);
  expectFunctionValidatorsAreDerived(index!, sources);
});

function expectBaseValidator(source: ts.SourceFile) {
  const declaration = findVariable(source, "articleFieldsValidator");
  expect(
    declaration,
    "declare articleFieldsValidator in convex/validators.ts",
  ).toBeDefined();
  expect(
    declaration!.initializer !== undefined &&
      ts.isCallExpression(declaration!.initializer) &&
      declaration!.initializer.expression.getText(source) === "v.object",
    "articleFieldsValidator must be a v.object",
  ).toBe(true);
}

function expectSingleFieldDeclarations(sources: Map<string, ts.SourceFile>) {
  const declarations = new Map<string, string[]>([
    ["title", []],
    ["body", []],
    ["slug", []],
    ["_id", []],
    ["_creationTime", []],
  ]);

  for (const [fileName, source] of sources) {
    const visit = (node: ts.Node) => {
      if (
        ts.isPropertyAssignment(node) &&
        (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
        declarations.has(node.name.text) &&
        ts.isCallExpression(node.initializer) &&
        node.initializer.expression.getText(source).startsWith("v.")
      ) {
        declarations
          .get(node.name.text)!
          .push(`${fileName}: ${node.getText(source)}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  for (const field of ["title", "body", "slug"]) {
    expect(
      declarations.get(field),
      `${field} must be declared exactly once`,
    ).toHaveLength(1);
    expect(declarations.get(field)![0]).toMatch(/^validators\.ts:/);
  }
  expect(declarations.get("_id")).toEqual([]);
  expect(declarations.get("_creationTime")).toEqual([]);
}

function expectSchemaUsesBase(source: ts.SourceFile) {
  let usesBase = false;
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(source) === "defineTable" &&
      node.arguments.some((argument) =>
        containsIdentifier(argument, "articleFieldsValidator"),
      )
    ) {
      usesBase = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  expect(usesBase, "defineTable must use articleFieldsValidator").toBe(true);
}

function expectFunctionValidatorsAreDerived(
  indexSource: ts.SourceFile,
  sources: Map<string, ts.SourceFile>,
) {
  const variables = new Map<string, ts.Expression>();
  const schemaImports = new Set<string>();
  const compositionMethods = new Set<string>();

  const collect = (node: ts.Node) => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === "./schema" &&
      node.importClause !== undefined
    ) {
      if (node.importClause.name !== undefined) {
        schemaImports.add(node.importClause.name.text);
      }
      const bindings = node.importClause.namedBindings;
      if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
        schemaImports.add(bindings.name.text);
      } else if (bindings !== undefined) {
        for (const element of bindings.elements) {
          schemaImports.add(element.name.text);
        }
      }
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined
    ) {
      variables.set(node.name.text, node.initializer);
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ["pick", "omit", "partial", "extend"].includes(
        node.expression.name.text,
      ) &&
      derivesFromBase(node.expression.expression, variables)
    ) {
      compositionMethods.add(node.expression.name.text);
    }
    ts.forEachChild(node, collect);
  };
  for (const source of sources.values()) collect(source);

  for (const functionName of ["createArticle", "updateArticle"]) {
    const args = registrationProperty(indexSource, functionName, "args");
    expect(args, `${functionName} must declare args`).toBeDefined();
    expect(
      derivesFromBase(args!, variables),
      `${functionName} args must derive from articleFieldsValidator`,
    ).toBe(true);
  }
  expect(
    compositionMethods.size,
    "compose the argument validators with at least three distinct operations",
  ).toBeGreaterThanOrEqual(3);

  const returns = registrationProperty(indexSource, "getArticle", "returns");
  expect(returns, "getArticle must declare returns").toBeDefined();
  expect(
    derivesFromSchemaDoc(returns!, variables, schemaImports),
    'getArticle returns must derive from schema.doc("articles")',
  ).toBe(true);
}

function derivesFromBase(
  expression: ts.Node,
  variables: Map<string, ts.Expression>,
  seen = new Set<string>(),
): boolean {
  if (ts.isIdentifier(expression)) {
    if (expression.text === "articleFieldsValidator") return true;
    if (seen.has(expression.text)) return false;
    const initializer = variables.get(expression.text);
    if (initializer === undefined) return false;
    seen.add(expression.text);
    const result = derivesFromBase(initializer, variables, seen);
    seen.delete(expression.text);
    return result;
  }
  let found = false;
  ts.forEachChild(expression, (child) => {
    if (!found && derivesFromBase(child, variables, seen)) {
      found = true;
    }
  });
  return found;
}

function derivesFromSchemaDoc(
  expression: ts.Node,
  variables: Map<string, ts.Expression>,
  schemaImports: Set<string>,
  seen = new Set<string>(),
): boolean {
  if (ts.isIdentifier(expression)) {
    if (seen.has(expression.text)) return false;
    const initializer = variables.get(expression.text);
    if (initializer === undefined) return false;
    seen.add(expression.text);
    const result = derivesFromSchemaDoc(
      initializer,
      variables,
      schemaImports,
      seen,
    );
    seen.delete(expression.text);
    return result;
  }
  if (
    ts.isCallExpression(expression) &&
    ts.isPropertyAccessExpression(expression.expression) &&
    ts.isIdentifier(expression.expression.expression) &&
    schemaImports.has(expression.expression.expression.text) &&
    expression.expression.name.text === "doc" &&
    expression.arguments.length === 1 &&
    ts.isStringLiteral(expression.arguments[0]) &&
    expression.arguments[0].text === "articles"
  ) {
    return true;
  }
  let found = false;
  ts.forEachChild(expression, (child) => {
    if (!found && derivesFromSchemaDoc(child, variables, schemaImports, seen)) {
      found = true;
    }
  });
  return found;
}

function registrationProperty(
  source: ts.SourceFile,
  functionName: string,
  propertyName: string,
): ts.Expression | undefined {
  const declaration = findVariable(source, functionName);
  if (
    declaration?.initializer === undefined ||
    !ts.isCallExpression(declaration.initializer) ||
    declaration.initializer.arguments.length === 0 ||
    !ts.isObjectLiteralExpression(declaration.initializer.arguments[0])
  ) {
    return undefined;
  }
  const property = declaration.initializer.arguments[0].properties.find(
    (candidate) =>
      ts.isPropertyAssignment(candidate) &&
      (ts.isIdentifier(candidate.name) || ts.isStringLiteral(candidate.name)) &&
      candidate.name.text === propertyName,
  );
  return property !== undefined && ts.isPropertyAssignment(property)
    ? property.initializer
    : undefined;
}

function findVariable(
  source: ts.SourceFile,
  name: string,
): ts.VariableDeclaration | undefined {
  let result: ts.VariableDeclaration | undefined;
  const visit = (node: ts.Node) => {
    if (
      result === undefined &&
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name
    ) {
      result = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return result;
}

function containsIdentifier(node: ts.Node, name: string): boolean {
  if (ts.isIdentifier(node) && node.text === name) return true;
  let found = false;
  ts.forEachChild(node, (child) => {
    if (!found && containsIdentifier(child, name)) found = true;
  });
  return found;
}

function authoredTypeScriptFiles(root: string): {
  absolutePath: string;
  relativePath: string;
}[] {
  const files: { absolutePath: string; relativePath: string }[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory)) {
      if (entry === "_generated" || entry === "node_modules") continue;
      const absolutePath = join(directory, entry);
      if (statSync(absolutePath).isDirectory()) {
        walk(absolutePath);
      } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
        files.push({
          absolutePath,
          relativePath: relative(root, absolutePath).replace(/\\/g, "/"),
        });
      }
    }
  };
  walk(root);
  return files;
}
