import { expect, test } from "vitest";
import { getLatestOutputProjectDir } from "../../../grader/outputDir";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import ts from "typescript";

const CATEGORY = "007-components";
const EVAL_NAME = "020-choose_presence_typing";

// SELECTION eval, static pipeline (see eval.json): measures whether the
// model CHOSE the presence component for auto-clearing chat typing indicators,
// tolerant of syntax/version/API noise. Correct token wiring and the
// component's runtime semantics are graded by the usage eval (018), not
// here. Checks are call-path-connected: endpoint handler -> local/imported
// helpers -> presence-instance method or direct components.* call.

const HEARTBEAT_ENDPOINT = "typingHeartbeat";
const LIST_ENDPOINT = "whoIsTyping";
const LEAVE_ENDPOINT = "stopTyping";
const ENDPOINT_NAMES = [
  HEARTBEAT_ENDPOINT,
  LIST_ENDPOINT,
  LEAVE_ENDPOINT,
] as const;

interface SourceModule {
  path: string; // normalized, relative to the project dir
  sourceFile: ts.SourceFile;
  declarations: Map<string, ts.Expression>;
  presenceCtorNames: Set<string>; // any binding imported from the package
  presenceNamespaces: Set<string>;
  componentsBindings: Set<string>;
  importsPresenceConfig: boolean;
  presenceConfigBindings: Set<string>;
  namedImports: Map<string, { targetPath: string; exportedName: string }>;
  namespaceImports: Map<string, string>;
  localFunctions: Map<string, ts.Node>;
  exportedFunctions: Map<string, ts.Node>;
  presenceInstances: Set<string>;
  exportedInstanceNames: Set<string>;
  hasDefaultInstanceExport: boolean;
}

interface Analysis {
  dependsOnPresence: boolean;
  mountsPresence: boolean;
  wiresComponent: boolean;
  endpointTouchesComponent: Record<string, boolean>;
  wallClockOnReadPath: string[];
}

function analyze(): Analysis {
  const projectDir = getLatestOutputProjectDir(CATEGORY, EVAL_NAME);

  let dependsOnPresence = false;
  try {
    const packageJson = JSON.parse(
      readFileSync(join(projectDir, "package.json"), "utf-8"),
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    dependsOnPresence =
      packageJson.dependencies?.["@convex-dev/presence"] !== undefined ||
      packageJson.devDependencies?.["@convex-dev/presence"] !== undefined;
  } catch {
    // Unparseable package.json: choice not visible.
  }

  const modules = readAuthoredModules(projectDir);
  const modulesByPath = new Map(modules.map((m) => [m.path, m]));

  // Propagate presence instances across module boundaries so instances
  // factored into their own module (a common, legitimate split) still count.
  for (let iteration = 0; iteration < modules.length + 1; iteration++) {
    let changed = false;
    for (const module of modules) {
      for (const [
        localName,
        { targetPath, exportedName },
      ] of module.namedImports) {
        const target = modulesByPath.get(targetPath);
        if (target === undefined) continue;
        const isInstance =
          exportedName === "default"
            ? target.hasDefaultInstanceExport
            : target.exportedInstanceNames.has(exportedName);
        if (isInstance && !module.presenceInstances.has(localName)) {
          module.presenceInstances.add(localName);
          changed = true;
        }
      }
      for (const statement of module.sourceFile.statements) {
        if (ts.isVariableStatement(statement) && hasExportModifier(statement)) {
          for (const declaration of statement.declarationList.declarations) {
            if (
              ts.isIdentifier(declaration.name) &&
              declaration.initializer !== undefined &&
              isPresenceInstanceExpression(
                module,
                modulesByPath,
                declaration.initializer,
              ) &&
              !module.exportedInstanceNames.has(declaration.name.text)
            ) {
              module.exportedInstanceNames.add(declaration.name.text);
              changed = true;
            }
          }
        } else if (
          ts.isExportAssignment(statement) &&
          !statement.isExportEquals &&
          isPresenceInstanceExpression(
            module,
            modulesByPath,
            statement.expression,
          ) &&
          !module.hasDefaultInstanceExport
        ) {
          module.hasDefaultInstanceExport = true;
          changed = true;
        } else if (
          ts.isExportDeclaration(statement) &&
          statement.exportClause !== undefined &&
          ts.isNamedExports(statement.exportClause)
        ) {
          const targetPath =
            statement.moduleSpecifier !== undefined &&
            ts.isStringLiteral(statement.moduleSpecifier)
              ? resolveLocalModulePath(
                  module.path,
                  statement.moduleSpecifier.text,
                  new Set(modulesByPath.keys()),
                )
              : undefined;
          for (const element of statement.exportClause.elements) {
            const localName = (element.propertyName ?? element.name).text;
            const target =
              targetPath === undefined
                ? undefined
                : modulesByPath.get(targetPath);
            const isInstance =
              target !== undefined
                ? localName === "default"
                  ? target.hasDefaultInstanceExport
                  : target.exportedInstanceNames.has(localName)
                : module.presenceInstances.has(localName);
            if (!isInstance) continue;
            if (element.name.text === "default") {
              if (!module.hasDefaultInstanceExport) {
                module.hasDefaultInstanceExport = true;
                changed = true;
              }
            } else if (!module.exportedInstanceNames.has(element.name.text)) {
              module.exportedInstanceNames.add(element.name.text);
              changed = true;
            }
          }
        }
      }
    }
    if (!changed) break;
  }

  let mountsPresence = false;
  let wiresComponent = false;
  for (const module of modules) {
    // Precise: the imported presence convex.config binding is passed to
    // .use(...). Loose fallback (selection evals tolerate stale spellings):
    // the file imports the presence config and mounts SOMETHING.
    if (
      module.presenceConfigBindings.size > 0 ||
      module.importsPresenceConfig
    ) {
      const usesBinding = fileMountsBinding(module);
      if (
        usesBinding ||
        (module.importsPresenceConfig &&
          /\.use\(/.test(module.sourceFile.getFullText()))
      ) {
        mountsPresence = true;
      }
    }
    if (module.presenceInstances.size > 0) {
      wiresComponent = true;
    }
  }

  const endpointTouchesComponent: Record<string, boolean> = {};
  const wallClockOnReadPath: string[] = [];

  for (const endpointName of ENDPOINT_NAMES) {
    endpointTouchesComponent[endpointName] = false;
    for (const module of modules) {
      const handler = findEndpointHandler(module, endpointName);
      if (handler === undefined) continue;
      const reached = new Set<string>();
      const wallClock: string[] = [];
      walkCallPath(module, modulesByPath, handler, 0, new Set(), {
        onComponentCall: (method) => reached.add(method),
        onWallClock:
          endpointName === LIST_ENDPOINT
            ? (construct, path) =>
                wallClock.push(
                  path +
                    ": " +
                    construct +
                    " on " +
                    endpointName +
                    "'s read path",
                )
            : undefined,
      });
      if (reached.size > 0) {
        endpointTouchesComponent[endpointName] = true;
      }
      wallClockOnReadPath.push(...wallClock);
    }
  }

  // Direct component calls anywhere also count as wiring (a model may skip
  // the client class and call the mounted component's functions directly).
  for (const module of modules) {
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ["runQuery", "runMutation", "runAction"].includes(
          node.expression.name.text,
        ) &&
        node.arguments.length >= 1 &&
        componentsChainSegments(module, node.arguments[0]) !== undefined
      ) {
        wiresComponent = true;
      }
      ts.forEachChild(node, visit);
    };
    visit(module.sourceFile);
  }

  return {
    dependsOnPresence,
    mountsPresence,
    wiresComponent,
    endpointTouchesComponent,
    wallClockOnReadPath,
  };
}

const analysis = analyze();

test("chooses the presence component as a dependency", () => {
  expect(analysis.dependsOnPresence).toBe(true);
});

test("mounts the component in the app config", () => {
  expect(analysis.mountsPresence).toBe(true);
});

test("wires the component (client class or direct calls)", () => {
  expect(analysis.wiresComponent).toBe(true);
});

test(`${HEARTBEAT_ENDPOINT} delegates to the component on its call path`, () => {
  expect(analysis.endpointTouchesComponent[HEARTBEAT_ENDPOINT]).toBe(true);
});

test(`${LIST_ENDPOINT} derives its entries from the component on its call path`, () => {
  expect(analysis.endpointTouchesComponent[LIST_ENDPOINT]).toBe(true);
});

test(`${LEAVE_ENDPOINT} delegates to the component on its call path`, () => {
  expect(analysis.endpointTouchesComponent[LEAVE_ENDPOINT]).toBe(true);
});

test("does not derive presence from the wall clock on the read path", () => {
  // Date.now()/new Date() in the query deriving presence is stale-by-design:
  // queries do not rerun as time passes. Wall-clock use in MUTATIONS is fine
  // and is deliberately not flagged.
  expect(analysis.wallClockOnReadPath).toEqual([]);
});

// ── Static analysis machinery ─────────────────────────────────────────

function readAuthoredModules(projectDir: string): SourceModule[] {
  const modules: SourceModule[] = [];
  const visit = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "_generated" || entry.name === "node_modules") {
        continue;
      }
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
      } else if (/\.[cm]?[jt]sx?$/.test(entry.name)) {
        const text = readFileSync(fullPath, "utf-8");
        const path = normalize(relative(projectDir, fullPath));
        modules.push(
          createSourceModule(
            path,
            ts.createSourceFile(
              path,
              text,
              ts.ScriptTarget.Latest,
              true,
              ts.ScriptKind.TS,
            ),
          ),
        );
      }
    }
  };
  visit(join(projectDir, "convex"));
  const paths = new Set(modules.map((m) => m.path));
  for (const module of modules) {
    resolveModuleImports(module, paths);
  }
  return modules;
}

function createSourceModule(
  path: string,
  sourceFile: ts.SourceFile,
): SourceModule {
  const module: SourceModule = {
    path,
    sourceFile,
    declarations: collectConstDeclarations(sourceFile),
    presenceCtorNames: new Set(),
    presenceNamespaces: new Set(),
    componentsBindings: new Set(),
    importsPresenceConfig: false,
    presenceConfigBindings: new Set(),
    namedImports: new Map(),
    namespaceImports: new Map(),
    localFunctions: new Map(),
    exportedFunctions: new Map(),
    presenceInstances: new Set(),
    exportedInstanceNames: new Set(),
    hasDefaultInstanceExport: false,
  };

  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      continue;
    }
    const specifier = statement.moduleSpecifier.text;
    const clause = statement.importClause;
    if (clause === undefined) continue;
    if (/^@convex-dev\/presence\/convex\.config(?:\.js)?$/.test(specifier)) {
      module.importsPresenceConfig = true;
      if (clause.name !== undefined) {
        module.presenceConfigBindings.add(clause.name.text);
      }
      const bindings = clause.namedBindings;
      if (bindings !== undefined && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          module.presenceConfigBindings.add(element.name.text);
        }
      } else if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
        module.presenceConfigBindings.add(bindings.name.text + ".default");
      }
    } else if (specifier === "@convex-dev/presence") {
      // Any binding imported from the package may be the client class -
      // selection grading tolerates renamed or stale-API imports.
      if (clause.name !== undefined) {
        module.presenceCtorNames.add(clause.name.text);
      }
      const bindings = clause.namedBindings;
      if (bindings !== undefined && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          module.presenceCtorNames.add(element.name.text);
        }
      } else if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
        module.presenceNamespaces.add(bindings.name.text);
      }
    }
    if (/(^|\/)_generated\/api(\.js)?$/.test(specifier)) {
      const bindings = clause.namedBindings;
      if (bindings !== undefined && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          if ((element.propertyName ?? element.name).text === "components") {
            module.componentsBindings.add(element.name.text);
          }
        }
      }
    }
  }

  const collectFunctions = (node: ts.Node) => {
    if (
      ts.isFunctionDeclaration(node) &&
      node.name !== undefined &&
      node.body !== undefined
    ) {
      module.localFunctions.set(node.name.text, node);
      if (hasExportModifier(node)) {
        module.exportedFunctions.set(node.name.text, node);
      }
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      (ts.isArrowFunction(node.initializer) ||
        ts.isFunctionExpression(node.initializer))
    ) {
      module.localFunctions.set(node.name.text, node.initializer);
      const statement = node.parent?.parent;
      if (
        statement !== undefined &&
        ts.isVariableStatement(statement) &&
        hasExportModifier(statement)
      ) {
        module.exportedFunctions.set(node.name.text, node.initializer);
      }
    }
    ts.forEachChild(node, collectFunctions);
  };
  collectFunctions(sourceFile);

  return module;
}

function resolveModuleImports(module: SourceModule, paths: Set<string>): void {
  for (const statement of module.sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !statement.moduleSpecifier.text.startsWith(".")
    ) {
      continue;
    }
    const targetPath = resolveLocalModulePath(
      module.path,
      statement.moduleSpecifier.text,
      paths,
    );
    if (targetPath === undefined) continue;
    const clause = statement.importClause;
    if (clause === undefined) continue;
    if (clause.name !== undefined) {
      module.namedImports.set(clause.name.text, {
        targetPath,
        exportedName: "default",
      });
    }
    const bindings = clause.namedBindings;
    if (bindings !== undefined && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        module.namedImports.set(element.name.text, {
          targetPath,
          exportedName: (element.propertyName ?? element.name).text,
        });
      }
    } else if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
      module.namespaceImports.set(bindings.name.text, targetPath);
    }
  }
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      isPresenceConstruction(module, node.initializer)
    ) {
      module.presenceInstances.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(module.sourceFile);
}

function fileMountsBinding(module: SourceModule): boolean {
  let mounted = false;
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "use" &&
      node.arguments[0] !== undefined
    ) {
      const component = resolveExpression(
        node.arguments[0],
        module.declarations,
      );
      if (
        (ts.isIdentifier(component) &&
          module.presenceConfigBindings.has(component.text)) ||
        (ts.isPropertyAccessExpression(component) &&
          ts.isIdentifier(component.expression) &&
          module.presenceConfigBindings.has(
            component.expression.text + "." + component.name.text,
          ))
      ) {
        mounted = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(module.sourceFile);
  return mounted;
}

function isPresenceConstruction(
  module: SourceModule,
  expression: ts.Expression,
): boolean {
  const resolved = resolveExpression(expression, module.declarations);
  if (!ts.isNewExpression(resolved)) return false;
  const ctor = resolveExpression(resolved.expression, module.declarations);
  const ctorMatches =
    (ts.isIdentifier(ctor) && module.presenceCtorNames.has(ctor.text)) ||
    (ts.isPropertyAccessExpression(ctor) &&
      ts.isIdentifier(ctor.expression) &&
      module.presenceNamespaces.has(ctor.expression.text));
  if (!ctorMatches) return false;
  const firstArg = resolved.arguments?.[0];
  if (firstArg === undefined) return false;
  return componentsChainSegments(module, firstArg) !== undefined;
}

function isPresenceInstanceExpression(
  module: SourceModule,
  modulesByPath: Map<string, SourceModule>,
  expression: ts.Expression,
): boolean {
  const resolved = resolveExpression(expression, module.declarations);
  if (ts.isIdentifier(resolved)) {
    return module.presenceInstances.has(resolved.text);
  }
  if (isPresenceConstruction(module, resolved)) return true;
  if (
    ts.isPropertyAccessExpression(resolved) &&
    ts.isIdentifier(resolved.expression)
  ) {
    const targetPath = module.namespaceImports.get(resolved.expression.text);
    const target =
      targetPath === undefined ? undefined : modulesByPath.get(targetPath);
    if (target !== undefined) {
      return resolved.name.text === "default"
        ? target.hasDefaultInstanceExport
        : target.exportedInstanceNames.has(resolved.name.text);
    }
  }
  return false;
}

function componentsChainSegments(
  module: SourceModule,
  expression: ts.Expression,
): string[] | undefined {
  let resolved = resolveExpression(expression, module.declarations);
  const segments: string[] = [];
  for (let i = 0; i < 12; i++) {
    if (ts.isPropertyAccessExpression(resolved)) {
      segments.unshift(resolved.name.text);
      resolved = resolved.expression;
      continue;
    }
    if (ts.isIdentifier(resolved)) {
      if (module.componentsBindings.has(resolved.text)) return segments;
      const aliased = module.declarations.get(resolved.text);
      if (aliased !== undefined && aliased !== expression) {
        const viaAlias = componentsChainSegments(
          { ...module, declarations: new Map() } as SourceModule,
          aliased,
        );
        if (viaAlias !== undefined) return [...viaAlias, ...segments];
      }
      return undefined;
    }
    return undefined;
  }
  return undefined;
}

function findEndpointHandler(
  module: SourceModule,
  endpointName: string,
): ts.Node | undefined {
  let handler: ts.Node | undefined;
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === endpointName &&
      node.initializer !== undefined &&
      ts.isCallExpression(node.initializer) &&
      node.initializer.arguments.length >= 1
    ) {
      const firstArg = node.initializer.arguments[0];
      if (ts.isObjectLiteralExpression(firstArg)) {
        for (const property of firstArg.properties) {
          const isHandler =
            property.name !== undefined &&
            (ts.isIdentifier(property.name) ||
              ts.isStringLiteral(property.name)) &&
            property.name.text === "handler";
          if (ts.isPropertyAssignment(property) && isHandler) {
            handler = resolveHandlerExpression(module, property.initializer);
          } else if (ts.isMethodDeclaration(property) && isHandler) {
            handler = property;
          }
        }
      } else if (
        ts.isArrowFunction(firstArg) ||
        ts.isFunctionExpression(firstArg)
      ) {
        // Tolerate the legacy function-form definition.
        handler = firstArg;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(module.sourceFile);
  return handler;
}

function resolveHandlerExpression(
  module: SourceModule,
  expression: ts.Expression,
): ts.Node {
  const resolved = resolveExpression(expression, module.declarations);
  if (ts.isIdentifier(resolved)) {
    const local = module.localFunctions.get(resolved.text);
    if (local !== undefined) return local;
  }
  return resolved;
}

/**
 * Walk a call path: the handler plus local/imported helpers (depth <= 4),
 * reporting presence-component operations and (optionally) wall-clock reads.
 */
function walkCallPath(
  module: SourceModule,
  modulesByPath: Map<string, SourceModule>,
  root: ts.Node,
  depth: number,
  visiting: Set<ts.Node>,
  callbacks: {
    onComponentCall: (method: string) => void;
    onWallClock?: (construct: string, path: string) => void;
  },
): void {
  if (depth > 4 || visiting.has(root)) return;
  visiting.add(root);

  const visit = (node: ts.Node) => {
    if (
      callbacks.onWallClock !== undefined &&
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "Date"
    ) {
      callbacks.onWallClock("new Date()", module.path);
    }
    if (ts.isCallExpression(node)) {
      if (ts.isPropertyAccessExpression(node.expression)) {
        const method = node.expression.name.text;
        const receiver = node.expression.expression;
        if (
          callbacks.onWallClock !== undefined &&
          method === "now" &&
          ts.isIdentifier(receiver) &&
          receiver.text === "Date"
        ) {
          callbacks.onWallClock("Date.now()", module.path);
        }
        if (isPresenceInstanceExpression(module, modulesByPath, receiver)) {
          callbacks.onComponentCall(method);
        }
        if (
          ["runQuery", "runMutation", "runAction"].includes(method) &&
          node.arguments.length >= 1
        ) {
          const segments = componentsChainSegments(module, node.arguments[0]);
          if (segments !== undefined && segments.length > 0) {
            callbacks.onComponentCall(segments[segments.length - 1]);
          }
        }
        if (ts.isIdentifier(receiver)) {
          const targetPath = module.namespaceImports.get(receiver.text);
          const target =
            targetPath === undefined
              ? undefined
              : modulesByPath.get(targetPath);
          const helper = target?.exportedFunctions.get(method);
          if (target !== undefined && helper !== undefined) {
            walkCallPath(
              target,
              modulesByPath,
              helper,
              depth + 1,
              visiting,
              callbacks,
            );
          }
        }
      } else if (ts.isIdentifier(node.expression)) {
        const name = node.expression.text;
        const local = module.localFunctions.get(name);
        if (local !== undefined) {
          walkCallPath(
            module,
            modulesByPath,
            local,
            depth + 1,
            visiting,
            callbacks,
          );
        } else {
          const imported = module.namedImports.get(name);
          const target =
            imported === undefined
              ? undefined
              : modulesByPath.get(imported.targetPath);
          const helper = target?.exportedFunctions.get(
            imported?.exportedName ?? "",
          );
          if (target !== undefined && helper !== undefined) {
            walkCallPath(
              target,
              modulesByPath,
              helper,
              depth + 1,
              visiting,
              callbacks,
            );
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  visiting.delete(root);
}

// ── Shared AST helpers ────────────────────────────────────────────────

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
      ts.isTypeAssertionExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isParenthesizedExpression(current) ||
      ts.isAwaitExpression(current)
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

function hasExportModifier(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    ts
      .getModifiers(node)
      ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ===
      true
  );
}

function resolveLocalModulePath(
  importerPath: string,
  specifier: string,
  paths: Set<string>,
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
  return candidates.find((candidate) => paths.has(candidate));
}
