import { expect, test } from "vitest";
import {
  compareFunctionSpec,
  compareSchema,
  getLatestOutputProjectDir,
  readOutputFile,
  responseClient,
} from "../../../grader";
import { anyApi } from "convex/server";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const CATEGORY = "007-components";
const EVAL_NAME = "000-aggregate_leaderboard";

test("compare schema", async ({ skip }) => {
  await compareSchema(skip);
});

test("compare function spec", async ({ skip }) => {
  // The task dictates the public surface; return validators are optional and
  // internal helpers (if any) are the model's business.
  await compareFunctionSpec(skip, { ignoreReturns: true, publicOnly: true });
});

// One stateful scenario: clearing the scores table via the admin helper
// would desynchronize the component-owned aggregate, so all behavior is
// exercised in a single ordered flow instead.
test(
  "counts and ranks stay correct through inserts, ties, and updates",
  { timeout: 30_000 },
  async () => {
    const submit = (userId: string, score: number) =>
      responseClient.mutation(anyApi.index.submitScore, { userId, score });
    const rankOf = (userId: string) =>
      responseClient.query(anyApi.index.getRank, { userId });
    const count = () => responseClient.query(anyApi.index.getCount, {});

    // Empty leaderboard.
    expect(await count()).toBe(0);
    expect(await rankOf("nobody")).toBeNull();

    // Two tied leaders and one trailing user: ranks 1, 1, 3.
    expect(await submit("alice", 100)).toBeDefined();
    expect(await submit("bob", 100)).toBeDefined();
    expect(await submit("carol", 50)).toBeDefined();

    expect(await count()).toBe(3);
    expect(await rankOf("alice")).toBe(1);
    expect(await rankOf("bob")).toBe(1);
    expect(await rankOf("carol")).toBe(3);
    expect(await rankOf("dave")).toBeNull();

    // Updating a returning user replaces their logical leaderboard entry: the
    // count must not change, and ranks must reflect the new ordering.
    expect(await submit("carol", 125)).toBeDefined();

    expect(await count()).toBe(3);
    expect(await rankOf("carol")).toBe(1);
    expect(await rankOf("alice")).toBe(2);
    expect(await rankOf("bob")).toBe(2);

    // Downgrade back below the tie and re-check - catches aggregates that
    // were inserted twice instead of replaced.
    await submit("carol", 10);
    expect(await count()).toBe(3);
    expect(await rankOf("carol")).toBe(3);
    expect(await rankOf("alice")).toBe(1);
    expect(await rankOf("bob")).toBe(1);

    // Exercise a wider distribution, including zero and negative scores. This
    // keeps either documented key direction valid: positive score keys with a
    // strict lower bound, or negated score keys with a strict upper bound.
    await submit("dave", -20);
    await submit("erin", 0);
    await submit("frank", 250);
    await submit("grace", 100);

    expect(await count()).toBe(7);
    expect(await rankOf("frank")).toBe(1);
    expect(await rankOf("alice")).toBe(2);
    expect(await rankOf("bob")).toBe(2);
    expect(await rankOf("grace")).toBe(2);
    expect(await rankOf("carol")).toBe(5);
    expect(await rankOf("erin")).toBe(6);
    expect(await rankOf("dave")).toBe(7);

    // Move a tied leader below every other score. This catches stale keys and
    // implementations that insert a replacement instead of moving it.
    expect(await submit("bob", -50)).toBeDefined();
    expect(await count()).toBe(7);
    expect(await rankOf("frank")).toBe(1);
    expect(await rankOf("alice")).toBe(2);
    expect(await rankOf("grace")).toBe(2);
    expect(await rankOf("carol")).toBe(4);
    expect(await rankOf("erin")).toBe(5);
    expect(await rankOf("dave")).toBe(6);
    expect(await rankOf("bob")).toBe(7);
  },
);

test("generated solution installs and mounts the aggregate component", () => {
  const packageJson = JSON.parse(
    readOutputFile(CATEGORY, EVAL_NAME, "package.json"),
  );
  expect(packageJson.dependencies["@convex-dev/aggregate"]).toBe("0.2.2");
  expect(packageJson.dependencies["convex"]).toBe("1.41.0");

  const config = readOutputFile(CATEGORY, EVAL_NAME, "convex/convex.config.ts");
  expect(hasAggregateMount(config)).toBe(true);
});

test("generated solution uses a synchronized TableAggregate without scans", () => {
  const analysis = analyzeAuthoredConvexSources();

  expect(
    analysis.hasTableAggregate,
    "construct a TableAggregate from @convex-dev/aggregate",
  ).toBe(true);
  expect(
    analysis.aggregateMethods.has("count"),
    "getCount must read from the TableAggregate",
  ).toBe(true);
  expect(
    analysis.hasBoundedRankRead,
    "getRank must use a bounded count, indexOf, or indexOfDoc",
  ).toBe(true);
  expect(
    analysis.hasDirectSynchronization || analysis.hasTriggerSynchronization,
    "synchronize both inserts and updates, directly or with a registered aggregate trigger",
  ).toBe(true);
  expect(
    analysis.scanConstructs,
    `table-enumeration constructs are not scalable: ${analysis.scanConstructs.join(", ")}`,
  ).toEqual([]);
});

function hasAggregateMount(sourceText: string): boolean {
  const sourceFile = ts.createSourceFile(
    "convex.config.ts",
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const aggregateImports = new Set<string>();
  const declarations = collectConstDeclarations(sourceFile);

  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !/^@convex-dev\/aggregate\/convex\.config(?:\.js)?$/.test(
        statement.moduleSpecifier.text,
      )
    ) {
      continue;
    }
    const defaultImport = statement.importClause?.name;
    if (defaultImport !== undefined) aggregateImports.add(defaultImport.text);
  }

  let mounted = false;
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "use" &&
      node.arguments[0] !== undefined
    ) {
      const component = resolveExpression(node.arguments[0], declarations);
      if (ts.isIdentifier(component) && aggregateImports.has(component.text)) {
        mounted = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return mounted;
}

type AuthoredSource = {
  path: string;
  sourceFile: ts.SourceFile;
};

type SourceAnalysis = {
  hasTableAggregate: boolean;
  aggregateMethods: Set<string>;
  hasBoundedRankRead: boolean;
  hasDirectSynchronization: boolean;
  hasTriggerSynchronization: boolean;
  scanConstructs: string[];
};

function analyzeAuthoredConvexSources(): SourceAnalysis {
  const sources = readAuthoredConvexSources();
  const tableAggregateConstructors = new Map<ts.SourceFile, Set<string>>();
  const tableAggregateNamespaces = new Map<ts.SourceFile, Set<string>>();
  const aggregateVariables = new Map<ts.SourceFile, Set<string>>();
  const declarations = new Map<ts.SourceFile, Map<string, ts.Expression>>();
  const exportedAggregateNames = new Set<string>();

  for (const { sourceFile } of sources) {
    const constructors = new Set<string>();
    const namespaces = new Set<string>();
    const variables = new Set<string>();
    const fileDeclarations = collectConstDeclarations(sourceFile);
    declarations.set(sourceFile, fileDeclarations);

    for (const statement of sourceFile.statements) {
      if (
        !ts.isImportDeclaration(statement) ||
        !ts.isStringLiteral(statement.moduleSpecifier) ||
        statement.moduleSpecifier.text !== "@convex-dev/aggregate"
      ) {
        continue;
      }
      const namedImports = statement.importClause?.namedBindings;
      if (namedImports !== undefined && ts.isNamedImports(namedImports)) {
        for (const element of namedImports.elements) {
          if (
            (element.propertyName ?? element.name).text === "TableAggregate"
          ) {
            constructors.add(element.name.text);
          }
        }
      } else if (
        namedImports !== undefined &&
        ts.isNamespaceImport(namedImports)
      ) {
        namespaces.add(namedImports.name.text);
      }
    }

    const visit = (node: ts.Node) => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer !== undefined &&
        isTableAggregateConstruction(
          resolveExpression(node.initializer, fileDeclarations),
          constructors,
          namespaces,
        )
      ) {
        variables.add(node.name.text);
        if (hasExportModifier(node.parent.parent)) {
          exportedAggregateNames.add(node.name.text);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);

    tableAggregateConstructors.set(sourceFile, constructors);
    tableAggregateNamespaces.set(sourceFile, namespaces);
    aggregateVariables.set(sourceFile, variables);
  }

  // A model may keep its aggregate in a helper module. Propagate named local
  // imports so method calls through an alias still count as real usage.
  for (const { sourceFile } of sources) {
    const variables = aggregateVariables.get(sourceFile)!;
    for (const statement of sourceFile.statements) {
      if (
        !ts.isImportDeclaration(statement) ||
        !ts.isStringLiteral(statement.moduleSpecifier) ||
        !statement.moduleSpecifier.text.startsWith(".")
      ) {
        continue;
      }
      const namedImports = statement.importClause?.namedBindings;
      if (namedImports !== undefined && ts.isNamedImports(namedImports)) {
        for (const element of namedImports.elements) {
          const importedName = (element.propertyName ?? element.name).text;
          if (exportedAggregateNames.has(importedName)) {
            variables.add(element.name.text);
          }
        }
      }
    }
  }

  const aggregateMethods = new Set<string>();
  const scanConstructs: string[] = [];
  let hasTableAggregate = false;
  let hasBoundedRankRead = false;
  let hasTriggerSynchronization = false;

  for (const { path, sourceFile } of sources) {
    const constructors = tableAggregateConstructors.get(sourceFile)!;
    const namespaces = tableAggregateNamespaces.get(sourceFile)!;
    const variables = aggregateVariables.get(sourceFile)!;
    const fileDeclarations = declarations.get(sourceFile)!;
    if (variables.size > 0) hasTableAggregate = true;

    const isAggregateReceiver = (expression: ts.Expression): boolean => {
      if (ts.isIdentifier(expression) && variables.has(expression.text)) {
        return true;
      }
      const resolved = resolveExpression(expression, fileDeclarations);
      return isTableAggregateConstruction(resolved, constructors, namespaces);
    };

    const visit = (node: ts.Node) => {
      if (ts.isForOfStatement(node) && node.awaitModifier !== undefined) {
        scanConstructs.push(`${path}: for await`);
      }
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression)
      ) {
        const method = node.expression.name.text;
        const receiver = node.expression.expression;

        if (isAggregateReceiver(receiver)) {
          aggregateMethods.add(method);
          if (
            (method === "count" && node.arguments.length >= 2) ||
            method === "indexOf" ||
            method === "indexOfDoc"
          ) {
            hasBoundedRankRead = true;
          }
        }

        if (method === "collect") {
          scanConstructs.push(`${path}: .${method}()`);
        }
        if (
          method === "paginate" &&
          (isAggregateReceiver(receiver) || chainQueriesScores(node))
        ) {
          scanConstructs.push(`${path}: .paginate()`);
        }
        if (
          method === "take" &&
          chainQueriesScores(node) &&
          !chainUsesIndex(node, "by_userId")
        ) {
          scanConstructs.push(`${path}: scores .take() without by_userId`);
        }
        if (method === "iter" && isAggregateReceiver(receiver)) {
          scanConstructs.push(`${path}: aggregate .iter()`);
        }
        if (method === "filter" && chainQueriesScores(node)) {
          scanConstructs.push(`${path}: scores .filter()`);
        }
        if (
          method === "first" &&
          chainQueriesScores(node) &&
          !chainUsesIndex(node, "by_userId")
        ) {
          scanConstructs.push(`${path}: scores .first() without by_userId`);
        }

        if (
          method === "register" &&
          node.arguments[0] !== undefined &&
          ts.isStringLiteralLike(node.arguments[0]) &&
          node.arguments[0].text === "scores" &&
          node.arguments[1] !== undefined &&
          containsAggregateTrigger(
            resolveExpression(node.arguments[1], fileDeclarations),
            isAggregateReceiver,
            fileDeclarations,
          )
        ) {
          hasTriggerSynchronization = true;
        }

        if (
          method === "fromAsync" &&
          ts.isIdentifier(receiver) &&
          receiver.text === "Array"
        ) {
          scanConstructs.push(`${path}: Array.fromAsync()`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  const hasInsert = ["insert", "insertIfDoesNotExist", "replaceOrInsert"].some(
    (method) => aggregateMethods.has(method),
  );
  const hasReplacement = ["replace", "replaceOrInsert"].some((method) =>
    aggregateMethods.has(method),
  );
  const hasDelete = ["delete", "deleteIfExists"].some((method) =>
    aggregateMethods.has(method),
  );

  return {
    hasTableAggregate,
    aggregateMethods,
    hasBoundedRankRead,
    hasDirectSynchronization: hasInsert && (hasReplacement || hasDelete),
    hasTriggerSynchronization,
    scanConstructs,
  };
}

function readAuthoredConvexSources(): AuthoredSource[] {
  const projectDir = getLatestOutputProjectDir(CATEGORY, EVAL_NAME);
  const convexDir = join(projectDir, "convex");
  const sources: AuthoredSource[] = [];

  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "_generated" || entry.name === "node_modules")
        continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
      } else if (/\.[cm]?[jt]sx?$/.test(entry.name)) {
        const path = relative(projectDir, fullPath);
        sources.push({
          path,
          sourceFile: ts.createSourceFile(
            path,
            readFileSync(fullPath, "utf8"),
            ts.ScriptTarget.Latest,
            true,
          ),
        });
      }
    }
  };
  visit(convexDir);
  return sources;
}

function collectConstDeclarations(
  sourceFile: ts.SourceFile,
): Map<string, ts.Expression> {
  const declarations = new Map<string, ts.Expression>();
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined
    ) {
      declarations.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return declarations;
}

function resolveExpression(
  expression: ts.Expression,
  declarations: Map<string, ts.Expression>,
): ts.Expression {
  let current = expression;
  const seen = new Set<string>();
  for (let i = 0; i < 8; i++) {
    if (
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isParenthesizedExpression(current)
    ) {
      current = current.expression;
    } else if (
      ts.isIdentifier(current) &&
      declarations.has(current.text) &&
      !seen.has(current.text)
    ) {
      seen.add(current.text);
      current = declarations.get(current.text)!;
    } else {
      break;
    }
  }
  return current;
}

function isTableAggregateConstruction(
  expression: ts.Expression,
  constructors: Set<string>,
  namespaces: Set<string>,
): boolean {
  return (
    ts.isNewExpression(expression) &&
    ((ts.isIdentifier(expression.expression) &&
      constructors.has(expression.expression.text)) ||
      (ts.isPropertyAccessExpression(expression.expression) &&
        expression.expression.name.text === "TableAggregate" &&
        ts.isIdentifier(expression.expression.expression) &&
        namespaces.has(expression.expression.expression.text)))
  );
}

function hasExportModifier(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    ts
      .getModifiers(node)
      ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ===
      true
  );
}

function chainQueriesScores(call: ts.CallExpression): boolean {
  let current: ts.Expression = call;
  while (
    ts.isCallExpression(current) &&
    ts.isPropertyAccessExpression(current.expression)
  ) {
    if (
      current.expression.name.text === "query" &&
      current.arguments[0] !== undefined &&
      ts.isStringLiteralLike(current.arguments[0]) &&
      current.arguments[0].text === "scores"
    ) {
      return true;
    }
    current = current.expression.expression;
  }
  return false;
}

function chainUsesIndex(call: ts.CallExpression, indexName: string): boolean {
  let current: ts.Expression = call;
  while (
    ts.isCallExpression(current) &&
    ts.isPropertyAccessExpression(current.expression)
  ) {
    if (
      current.expression.name.text === "withIndex" &&
      current.arguments[0] !== undefined &&
      ts.isStringLiteralLike(current.arguments[0]) &&
      current.arguments[0].text === indexName
    ) {
      return true;
    }
    current = current.expression.expression;
  }
  return false;
}

function containsAggregateTrigger(
  expression: ts.Expression,
  isAggregateReceiver: (expression: ts.Expression) => boolean,
  declarations: Map<string, ts.Expression>,
): boolean {
  const resolved = resolveExpression(expression, declarations);
  let found = false;
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ["trigger", "idempotentTrigger"].includes(node.expression.name.text) &&
      isAggregateReceiver(node.expression.expression)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(resolved);
  return found;
}
