import { expect, test } from "vitest";
import { getLatestOutputProjectDir, readOutputFile } from "../../../grader/outputDir";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const CATEGORY = "007-components";
const EVAL_NAME = "007-choose_aggregate_range_sums";

// This is a SELECTION eval with a static pipeline (see eval.json): it
// measures what the model CHOSE, deliberately tolerant of syntax errors,
// stale versions, and API slips that the usage eval (000) grades. The
// TypeScript parser is error-recovering, so choices remain visible in the
// AST even when the code would not compile.

interface Analysis {
  dependsOnAggregate: boolean;
  mountsAggregate: boolean;
  constructsClient: boolean;
  synchronizesWrites: boolean;
  readsFromAggregate: boolean;
  usesSum: boolean;
  configuresSumValue: boolean;
  scanConstructs: string[];
}

function analyze(): Analysis {
  const projectDir = getLatestOutputProjectDir(CATEGORY, EVAL_NAME);

  let dependsOnAggregate = false;
  try {
    const packageJson = JSON.parse(
      readOutputFile(CATEGORY, EVAL_NAME, "package.json"),
    ) as { dependencies?: Record<string, string> };
    dependsOnAggregate =
      packageJson.dependencies?.["@convex-dev/aggregate"] !== undefined;
  } catch {
    // Unparseable package.json: dependency choice not visible.
  }

  const sources: ts.SourceFile[] = [];
  const load = (relativeDir: string) => {
    let entries;
    try {
      entries = readdirSync(join(projectDir, "convex", relativeDir), {
        withFileTypes: true,
      });
    } catch {
      return;
    }
    for (const entry of entries) {
      const relativePath =
        relativeDir === "" ? entry.name : `${relativeDir}/${entry.name}`;
      if (entry.isDirectory() && entry.name !== "_generated") {
        load(relativePath);
      }
      if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
      const text = readFileSync(
        join(projectDir, "convex", relativePath),
        "utf-8",
      );
      sources.push(
        ts.createSourceFile(
          relativePath,
          text,
          ts.ScriptTarget.Latest,
          true,
          ts.ScriptKind.TS,
        ),
      );
    }
  };
  load("");

  let mountsAggregate = false;
  let constructsClient = false;
  let synchronizesWrites = false;
  let readsFromAggregate = false;
  let usesSum = false;
  let configuresSumValue = false;
  const scanConstructs: string[] = [];

  const writeMethods = new Set([
    "insert",
    "insertIfDoesNotExist",
    "replace",
    "replaceOrInsert",
    "delete",
    "deleteIfExists",
  ]);
  const readMethods = new Set(["count", "indexOf", "indexOfDoc", "at", "sum"]);
  const scanMethods = new Set(["collect", "take", "filter", "paginate"]);

  for (const sourceFile of sources) {
    // Imported client constructor names from @convex-dev/aggregate.
    const clientCtors = new Set<string>();
    for (const statement of sourceFile.statements) {
      if (
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier)
      ) {
        const spec = statement.moduleSpecifier.text;
        if (/^@convex-dev\/aggregate\/convex\.config(?:\.js)?$/.test(spec)) {
          mountsAggregate =
            mountsAggregate || /\.use\(/.test(sourceFile.getFullText());
        }
        if (spec === "@convex-dev/aggregate") {
          const bindings = statement.importClause?.namedBindings;
          if (bindings !== undefined && ts.isNamedImports(bindings)) {
            for (const element of bindings.elements) {
              clientCtors.add(element.name.text);
            }
          }
        }
      }
    }

    // Client instance variable names in this file. Unwrap parens and
    // as-casts (e.g. `new Aggregate(...) as unknown as X`).
    const unwrap = (expression: ts.Expression): ts.Expression => {
      let current = expression;
      while (
        ts.isParenthesizedExpression(current) ||
        ts.isAsExpression(current)
      ) {
        current = current.expression;
      }
      return current;
    };
    const clientVars = new Set<string>();
    const collectVars = (node: ts.Node) => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer !== undefined
      ) {
        const initializer = unwrap(node.initializer);
        if (
          ts.isNewExpression(initializer) &&
          ts.isIdentifier(initializer.expression) &&
          clientCtors.has(initializer.expression.text)
        ) {
          const firstArg = initializer.arguments?.[0];
          if (
            firstArg !== undefined &&
            firstArg.getText().startsWith("components.")
          ) {
            constructsClient = true;
            clientVars.add(node.name.text);
            const options = initializer.arguments?.[1];
            if (
              options !== undefined &&
              ts.isObjectLiteralExpression(options) &&
              options.properties.some(
                (property) =>
                  property.name !== undefined &&
                  ts.isIdentifier(property.name) &&
                  property.name.text === "sumValue",
              )
            ) {
              configuresSumValue = true;
            }
          }
        }
      }
      ts.forEachChild(node, collectVars);
    };
    collectVars(sourceFile);

    const chainQueriesScores = (call: ts.CallExpression): boolean => {
      let current: ts.Expression = call;
      let boundedByUser = false;
      let queriesScores = false;
      while (
        ts.isCallExpression(current) &&
        ts.isPropertyAccessExpression(current.expression)
      ) {
        const name = current.expression.name.text;
        const arg = current.arguments[0];
        if (
          name === "query" &&
          arg !== undefined &&
          ts.isStringLiteralLike(arg) &&
          arg.text === "transactions"
        ) {
          queriesScores = true;
        }
        if (
          name === "withIndex" &&
          arg !== undefined &&
          ts.isStringLiteralLike(arg) &&
          arg.text === "__none__"
        ) {
          boundedByUser = true;
        }
        current = current.expression.expression;
      }
      return queriesScores && !boundedByUser;
    };

    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression)
      ) {
        const name = node.expression.name.text;
        const receiver = node.expression.expression;
        if (ts.isIdentifier(receiver) && clientVars.has(receiver.text)) {
          if (writeMethods.has(name)) synchronizesWrites = true;
          if (readMethods.has(name)) readsFromAggregate = true;
          if (name === "sum") usesSum = true;
        }
        // Direct component calls also count as wiring: invocation STYLE is
        // an API detail the docs-equipped usage eval grades, not this one.
        if (
          (name === "runMutation" || name === "runQuery") &&
          node.arguments.length >= 1 &&
          node.arguments[0].getText().startsWith("components.aggregate.")
        ) {
          if (name === "runMutation") synchronizesWrites = true;
          if (name === "runQuery") readsFromAggregate = true;
          constructsClient = constructsClient || true;
        }
        if (scanMethods.has(name) && chainQueriesScores(node)) {
          scanConstructs.push(`${sourceFile.fileName}: unbounded transactions .${name}()`);
        }
      }
      if (
        ts.isForOfStatement(node) &&
        node.awaitModifier !== undefined &&
        ts.isCallExpression(node.expression) &&
        chainQueriesScores(node.expression)
      ) {
        scanConstructs.push(`${sourceFile.fileName}: unbounded transactions for-await`);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  return {
    dependsOnAggregate,
    mountsAggregate,
    constructsClient,
    synchronizesWrites,
    readsFromAggregate,
    usesSum,
    configuresSumValue,
    scanConstructs,
  };
}

const analysis = analyze();

test("chooses the aggregate component as a dependency", () => {
  expect(analysis.dependsOnAggregate).toBe(true);
});

test("mounts the component in the app config", () => {
  expect(analysis.mountsAggregate).toBe(true);
});

test("wires the component (client class or direct calls)", () => {
  expect(analysis.constructsClient).toBe(true);
});

test("synchronizes aggregate writes alongside table writes", () => {
  expect(analysis.synchronizesWrites).toBe(true);
});

test("serves range-sum reads with the aggregate sum() API", () => {
  expect(analysis.usesSum).toBe(true);
});

test("configures sumValue so sums aggregate the amount", () => {
  expect(analysis.configuresSumValue).toBe(true);
});

test("does not fall back to scanning the scores table", () => {
  expect(analysis.scanConstructs).toEqual([]);
});
