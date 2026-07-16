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
import { dirname, join, normalize, relative } from "node:path";
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
  const sourcePaths = new Set(sources.map(({ path }) => normalize(path)));
  const tableAggregateConstructors = new Map<ts.SourceFile, Set<string>>();
  const tableAggregateNamespaces = new Map<ts.SourceFile, Set<string>>();
  const aggregateVariables = new Map<ts.SourceFile, Set<string>>();
  const localModuleNamespaces = new Map<ts.SourceFile, Map<string, string>>();
  const declarations = new Map<ts.SourceFile, Map<string, ts.Expression>>();
  const aggregateExports = new Map<
    string,
    { named: Set<string>; hasDefault: boolean }
  >(
    sources.map(({ path }) => [
      normalize(path),
      { named: new Set<string>(), hasDefault: false },
    ]),
  );

  for (const { path, sourceFile } of sources) {
    const constructors = new Set<string>();
    const namespaces = new Set<string>();
    const variables = new Set<string>();
    const moduleNamespaces = new Map<string, string>();
    const fileDeclarations = collectConstDeclarations(sourceFile);
    declarations.set(sourceFile, fileDeclarations);

    for (const statement of sourceFile.statements) {
      if (
        !ts.isImportDeclaration(statement) ||
        !ts.isStringLiteral(statement.moduleSpecifier) ||
        statement.moduleSpecifier.text !== "@convex-dev/aggregate"
      ) {
        if (
          ts.isImportDeclaration(statement) &&
          ts.isStringLiteral(statement.moduleSpecifier) &&
          statement.moduleSpecifier.text.startsWith(".")
        ) {
          const targetPath = resolveLocalSourcePath(
            path,
            statement.moduleSpecifier.text,
            sourcePaths,
          );
          const bindings = statement.importClause?.namedBindings;
          if (
            targetPath !== undefined &&
            bindings !== undefined &&
            ts.isNamespaceImport(bindings)
          ) {
            moduleNamespaces.set(bindings.name.text, targetPath);
          }
        }
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
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);

    tableAggregateConstructors.set(sourceFile, constructors);
    tableAggregateNamespaces.set(sourceFile, namespaces);
    aggregateVariables.set(sourceFile, variables);
    localModuleNamespaces.set(sourceFile, moduleNamespaces);
  }

  const expressionIsAggregate = (
    sourceFile: ts.SourceFile,
    expression: ts.Expression,
  ): boolean => {
    const resolved = resolveExpression(
      expression,
      declarations.get(sourceFile)!,
    );
    if (
      ts.isIdentifier(resolved) &&
      aggregateVariables.get(sourceFile)!.has(resolved.text)
    ) {
      return true;
    }
    if (
      isTableAggregateConstruction(
        resolved,
        tableAggregateConstructors.get(sourceFile)!,
        tableAggregateNamespaces.get(sourceFile)!,
      )
    ) {
      return true;
    }
    if (
      ts.isPropertyAccessExpression(resolved) &&
      ts.isIdentifier(resolved.expression)
    ) {
      const targetPath = localModuleNamespaces
        .get(sourceFile)!
        .get(resolved.expression.text);
      const targetExports =
        targetPath === undefined ? undefined : aggregateExports.get(targetPath);
      return (
        targetExports !== undefined &&
        (resolved.name.text === "default"
          ? targetExports.hasDefault
          : targetExports.named.has(resolved.name.text))
      );
    }
    return false;
  };

  // Resolve Aggregate bindings through local modules. Iterate so default,
  // named, namespace, aliased, and re-exported helpers all converge without
  // confusing an unrelated import in another file for the Aggregate.
  for (let iteration = 0; iteration < sources.length * 2 + 1; iteration++) {
    let changed = false;

    for (const { path, sourceFile } of sources) {
      const variables = aggregateVariables.get(sourceFile)!;
      for (const statement of sourceFile.statements) {
        if (
          !ts.isImportDeclaration(statement) ||
          !ts.isStringLiteral(statement.moduleSpecifier) ||
          !statement.moduleSpecifier.text.startsWith(".")
        ) {
          continue;
        }
        const targetPath = resolveLocalSourcePath(
          path,
          statement.moduleSpecifier.text,
          sourcePaths,
        );
        const targetExports =
          targetPath === undefined
            ? undefined
            : aggregateExports.get(targetPath);
        if (targetExports === undefined) continue;

        const defaultImport = statement.importClause?.name;
        if (
          defaultImport !== undefined &&
          targetExports.hasDefault &&
          !variables.has(defaultImport.text)
        ) {
          variables.add(defaultImport.text);
          changed = true;
        }
        const namedImports = statement.importClause?.namedBindings;
        if (namedImports !== undefined && ts.isNamedImports(namedImports)) {
          for (const element of namedImports.elements) {
            const importedName = (element.propertyName ?? element.name).text;
            const importedIsAggregate =
              importedName === "default"
                ? targetExports.hasDefault
                : targetExports.named.has(importedName);
            if (importedIsAggregate && !variables.has(element.name.text)) {
              variables.add(element.name.text);
              changed = true;
            }
          }
        }
      }

      const exports = aggregateExports.get(normalize(path))!;
      for (const statement of sourceFile.statements) {
        if (ts.isVariableStatement(statement) && hasExportModifier(statement)) {
          for (const declaration of statement.declarationList.declarations) {
            if (
              ts.isIdentifier(declaration.name) &&
              expressionIsAggregate(sourceFile, declaration.name) &&
              !exports.named.has(declaration.name.text)
            ) {
              exports.named.add(declaration.name.text);
              changed = true;
            }
          }
        } else if (
          ts.isExportAssignment(statement) &&
          !statement.isExportEquals &&
          expressionIsAggregate(sourceFile, statement.expression) &&
          !exports.hasDefault
        ) {
          exports.hasDefault = true;
          changed = true;
        } else if (
          ts.isExportDeclaration(statement) &&
          (statement.exportClause === undefined ||
            ts.isNamedExports(statement.exportClause))
        ) {
          const targetPath =
            statement.moduleSpecifier !== undefined &&
            ts.isStringLiteral(statement.moduleSpecifier) &&
            statement.moduleSpecifier.text.startsWith(".")
              ? resolveLocalSourcePath(
                  path,
                  statement.moduleSpecifier.text,
                  sourcePaths,
                )
              : undefined;
          const targetExports =
            targetPath === undefined
              ? undefined
              : aggregateExports.get(targetPath);

          if (statement.exportClause === undefined) {
            if (targetExports !== undefined) {
              for (const name of targetExports.named) {
                if (!exports.named.has(name)) {
                  exports.named.add(name);
                  changed = true;
                }
              }
            }
            continue;
          }

          for (const element of statement.exportClause.elements) {
            const localName = (element.propertyName ?? element.name).text;
            const isAggregate =
              targetExports === undefined
                ? expressionIsAggregate(
                    sourceFile,
                    ts.factory.createIdentifier(localName),
                  )
                : localName === "default"
                  ? targetExports.hasDefault
                  : targetExports.named.has(localName);
            if (!isAggregate) continue;

            if (element.name.text === "default") {
              if (!exports.hasDefault) {
                exports.hasDefault = true;
                changed = true;
              }
            } else if (!exports.named.has(element.name.text)) {
              exports.named.add(element.name.text);
              changed = true;
            }
          }
        }
      }
    }

    if (!changed) break;
  }

  resolveLocalStringConstants(
    sources,
    sourcePaths,
    declarations,
    localModuleNamespaces,
  );

  const aggregateMethods = new Set<string>();
  const scanConstructs: string[] = [];
  let hasTableAggregate = false;
  let hasBoundedRankRead = false;
  let hasTriggerSynchronization = false;

  for (const { path, sourceFile } of sources) {
    const variables = aggregateVariables.get(sourceFile)!;
    const fileDeclarations = declarations.get(sourceFile)!;
    if (variables.size > 0) hasTableAggregate = true;

    const isAggregateReceiver = (expression: ts.Expression): boolean =>
      expressionIsAggregate(sourceFile, expression);

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
          hasTableAggregate = true;
          aggregateMethods.add(method);
          if (
            (method === "count" && node.arguments.length >= 2) ||
            method === "indexOf" ||
            method === "indexOfDoc"
          ) {
            hasBoundedRankRead = true;
          }
        }

        const queriesScores = chainQueriesScores(node, fileDeclarations);
        const hasBoundedUserLookup = chainUsesEqualityBoundedIndex(
          node,
          "by_userId",
          "userId",
          fileDeclarations,
        );

        // Equality-bounding the declared user index limits the range to the
        // one-current-score invariant, so collect/filter/paginate stay O(1).
        // A literal take(1), like first(), is also O(1); behavior tests still
        // decide whether that lookup found the requested user.
        if (method === "collect" && queriesScores && !hasBoundedUserLookup) {
          scanConstructs.push(`${path}: unbounded scores .collect()`);
        }
        if (
          method === "paginate" &&
          (isAggregateReceiver(receiver) ||
            (queriesScores && !hasBoundedUserLookup))
        ) {
          scanConstructs.push(`${path}: .paginate()`);
        }
        if (
          method === "take" &&
          queriesScores &&
          !hasBoundedUserLookup &&
          !takesAtMostOne(node, fileDeclarations)
        ) {
          scanConstructs.push(`${path}: unbounded scores .take()`);
        }
        if (method === "iter" && isAggregateReceiver(receiver)) {
          scanConstructs.push(`${path}: aggregate .iter()`);
        }
        if (method === "filter" && queriesScores && !hasBoundedUserLookup) {
          scanConstructs.push(`${path}: unbounded scores .filter()`);
        }

        if (
          method === "register" &&
          node.arguments[0] !== undefined &&
          resolvesToStringLiteral(
            node.arguments[0],
            "scores",
            fileDeclarations,
          ) &&
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

function resolveLocalSourcePath(
  importerPath: string,
  specifier: string,
  sourcePaths: Set<string>,
): string | undefined {
  const base = normalize(join(dirname(importerPath), specifier));
  const withoutExtension = base.replace(/\.[cm]?[jt]sx?$/, "");
  const candidates = [
    base,
    ...["ts", "tsx", "js", "jsx", "mts", "cts", "mjs", "cjs"].map(
      (extension) => `${withoutExtension}.${extension}`,
    ),
    ...["ts", "tsx", "js", "jsx", "mts", "cts", "mjs", "cjs"].map((extension) =>
      join(base, `index.${extension}`),
    ),
  ];
  return candidates.find((candidate) => sourcePaths.has(candidate));
}

function resolveLocalStringConstants(
  sources: AuthoredSource[],
  sourcePaths: Set<string>,
  declarations: Map<ts.SourceFile, Map<string, ts.Expression>>,
  localModuleNamespaces: Map<ts.SourceFile, Map<string, string>>,
): void {
  const stringExports = new Map<
    string,
    { named: Map<string, string>; defaultValue?: string }
  >(
    sources.map(({ path }) => [
      normalize(path),
      { named: new Map<string, string>() },
    ]),
  );

  const setDeclaration = (
    fileDeclarations: Map<string, ts.Expression>,
    name: string,
    value: string,
  ): boolean => {
    const existing = fileDeclarations.get(name);
    if (
      existing !== undefined &&
      resolveStringLiteralValue(existing, fileDeclarations) === value
    ) {
      return false;
    }
    fileDeclarations.set(name, ts.factory.createStringLiteral(value));
    return true;
  };

  const setExport = (
    exports: { named: Map<string, string>; defaultValue?: string },
    name: string,
    value: string,
  ): boolean => {
    if (name === "default") {
      if (exports.defaultValue === value) return false;
      exports.defaultValue = value;
      return true;
    }
    if (exports.named.get(name) === value) return false;
    exports.named.set(name, value);
    return true;
  };

  for (let iteration = 0; iteration < sources.length * 2 + 1; iteration++) {
    let changed = false;

    for (const { path, sourceFile } of sources) {
      const fileDeclarations = declarations.get(sourceFile)!;

      for (const statement of sourceFile.statements) {
        if (
          !ts.isImportDeclaration(statement) ||
          !ts.isStringLiteral(statement.moduleSpecifier) ||
          !statement.moduleSpecifier.text.startsWith(".")
        ) {
          continue;
        }
        const targetPath = resolveLocalSourcePath(
          path,
          statement.moduleSpecifier.text,
          sourcePaths,
        );
        const targetExports =
          targetPath === undefined ? undefined : stringExports.get(targetPath);
        if (targetExports === undefined) continue;

        const defaultImport = statement.importClause?.name;
        if (
          defaultImport !== undefined &&
          targetExports.defaultValue !== undefined
        ) {
          changed =
            setDeclaration(
              fileDeclarations,
              defaultImport.text,
              targetExports.defaultValue,
            ) || changed;
        }

        const bindings = statement.importClause?.namedBindings;
        if (bindings !== undefined && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            const importedName = (element.propertyName ?? element.name).text;
            const value =
              importedName === "default"
                ? targetExports.defaultValue
                : targetExports.named.get(importedName);
            if (value !== undefined) {
              changed =
                setDeclaration(fileDeclarations, element.name.text, value) ||
                changed;
            }
          }
        }
      }

      for (const [namespace, targetPath] of localModuleNamespaces.get(
        sourceFile,
      )!) {
        const targetExports = stringExports.get(targetPath)!;
        if (targetExports.defaultValue !== undefined) {
          changed =
            setDeclaration(
              fileDeclarations,
              `${namespace}.default`,
              targetExports.defaultValue,
            ) || changed;
        }
        for (const [name, value] of targetExports.named) {
          changed =
            setDeclaration(fileDeclarations, `${namespace}.${name}`, value) ||
            changed;
        }
      }

      const exports = stringExports.get(normalize(path))!;
      for (const statement of sourceFile.statements) {
        if (ts.isVariableStatement(statement) && hasExportModifier(statement)) {
          for (const declaration of statement.declarationList.declarations) {
            if (!ts.isIdentifier(declaration.name)) continue;
            const value = resolveStringLiteralValue(
              declaration.name,
              fileDeclarations,
            );
            if (value !== undefined) {
              changed =
                setExport(exports, declaration.name.text, value) || changed;
            }
          }
        } else if (
          ts.isExportAssignment(statement) &&
          !statement.isExportEquals
        ) {
          const value = resolveStringLiteralValue(
            statement.expression,
            fileDeclarations,
          );
          if (value !== undefined) {
            changed = setExport(exports, "default", value) || changed;
          }
        } else if (
          ts.isExportDeclaration(statement) &&
          (statement.exportClause === undefined ||
            ts.isNamedExports(statement.exportClause))
        ) {
          const targetPath =
            statement.moduleSpecifier !== undefined &&
            ts.isStringLiteral(statement.moduleSpecifier) &&
            statement.moduleSpecifier.text.startsWith(".")
              ? resolveLocalSourcePath(
                  path,
                  statement.moduleSpecifier.text,
                  sourcePaths,
                )
              : undefined;
          const targetExports =
            targetPath === undefined
              ? undefined
              : stringExports.get(targetPath);

          if (statement.exportClause === undefined) {
            if (targetExports !== undefined) {
              for (const [name, value] of targetExports.named) {
                changed = setExport(exports, name, value) || changed;
              }
            }
            continue;
          }

          for (const element of statement.exportClause.elements) {
            const localName = (element.propertyName ?? element.name).text;
            const value =
              targetExports === undefined
                ? resolveStringLiteralValue(
                    ts.factory.createIdentifier(localName),
                    fileDeclarations,
                  )
                : localName === "default"
                  ? targetExports.defaultValue
                  : targetExports.named.get(localName);
            if (value !== undefined) {
              changed = setExport(exports, element.name.text, value) || changed;
            }
          }
        }
      }
    }

    if (!changed) break;
  }
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
    } else if (
      ts.isPropertyAccessExpression(current) &&
      ts.isIdentifier(current.expression) &&
      declarations.has(`${current.expression.text}.${current.name.text}`) &&
      !seen.has(`${current.expression.text}.${current.name.text}`)
    ) {
      const key = `${current.expression.text}.${current.name.text}`;
      seen.add(key);
      current = declarations.get(key)!;
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

function chainQueriesScores(
  call: ts.CallExpression,
  declarations: Map<string, ts.Expression>,
): boolean {
  return callChainSome(call, declarations, (current) => {
    return (
      current.expression.name.text === "query" &&
      current.arguments[0] !== undefined &&
      resolvesToStringLiteral(current.arguments[0], "scores", declarations)
    );
  });
}

function chainUsesEqualityBoundedIndex(
  call: ts.CallExpression,
  indexName: string,
  fieldName: string,
  declarations: Map<string, ts.Expression>,
): boolean {
  return callChainSome(call, declarations, (current) => {
    if (
      current.expression.name.text === "withIndex" &&
      current.arguments[0] !== undefined &&
      resolvesToStringLiteral(current.arguments[0], indexName, declarations) &&
      current.arguments[1] !== undefined
    ) {
      return rangeCallbackUsesEqualityBound(
        current.arguments[1],
        fieldName,
        declarations,
      );
    }
    return false;
  });
}

function rangeCallbackUsesEqualityBound(
  callbackExpression: ts.Expression,
  fieldName: string,
  declarations: Map<string, ts.Expression>,
): boolean {
  const callback = resolveExpression(callbackExpression, declarations);
  if (
    (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) ||
    callback.parameters.length === 0 ||
    !ts.isIdentifier(callback.parameters[0].name)
  ) {
    return false;
  }

  const returnedExpressions: ts.Expression[] = [];
  if (ts.isBlock(callback.body)) {
    const visit = (node: ts.Node) => {
      if (node !== callback.body && ts.isFunctionLike(node)) return;
      if (ts.isReturnStatement(node) && node.expression !== undefined) {
        returnedExpressions.push(node.expression);
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(callback.body);
  } else {
    returnedExpressions.push(callback.body);
  }

  const rangeParameter = callback.parameters[0].name.text;
  return (
    returnedExpressions.length > 0 &&
    returnedExpressions.every((expression) =>
      expressionChainUsesEqualityBound(
        expression,
        rangeParameter,
        fieldName,
        declarations,
      ),
    )
  );
}

function expressionChainUsesEqualityBound(
  expression: ts.Expression,
  rangeParameter: string,
  fieldName: string,
  declarations: Map<string, ts.Expression>,
): boolean {
  let current = expression;
  let hasEqualityBound = false;
  for (let i = 0; i < 20; i++) {
    current = resolveExpression(current, declarations);
    if (
      !ts.isCallExpression(current) ||
      !ts.isPropertyAccessExpression(current.expression)
    ) {
      return (
        hasEqualityBound &&
        ts.isIdentifier(current) &&
        current.text === rangeParameter
      );
    }
    if (
      current.expression.name.text === "eq" &&
      current.arguments[0] !== undefined &&
      resolvesToStringLiteral(current.arguments[0], fieldName, declarations)
    ) {
      hasEqualityBound = true;
    }
    current = current.expression.expression;
  }
  return false;
}

function takesAtMostOne(
  call: ts.CallExpression,
  declarations: Map<string, ts.Expression>,
): boolean {
  if (call.arguments[0] === undefined) return false;
  const amount = resolveExpression(call.arguments[0], declarations);
  return ts.isNumericLiteral(amount) && Number(amount.text) <= 1;
}

function resolvesToStringLiteral(
  expression: ts.Expression,
  expected: string,
  declarations: Map<string, ts.Expression>,
): boolean {
  return resolveStringLiteralValue(expression, declarations) === expected;
}

function resolveStringLiteralValue(
  expression: ts.Expression,
  declarations: Map<string, ts.Expression>,
): string | undefined {
  const resolved = resolveExpression(expression, declarations);
  return ts.isStringLiteralLike(resolved) ? resolved.text : undefined;
}

function callChainSome(
  call: ts.CallExpression,
  declarations: Map<string, ts.Expression>,
  predicate: (
    call: ts.CallExpression & {
      expression: ts.PropertyAccessExpression;
    },
  ) => boolean,
): boolean {
  let current: ts.Expression = call;
  for (let i = 0; i < 20; i++) {
    current = resolveExpression(current, declarations);
    if (
      !ts.isCallExpression(current) ||
      !ts.isPropertyAccessExpression(current.expression)
    ) {
      return false;
    }
    if (
      predicate(
        current as ts.CallExpression & {
          expression: ts.PropertyAccessExpression;
        },
      )
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
