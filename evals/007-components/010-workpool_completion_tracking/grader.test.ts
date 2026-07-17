import { expect, test } from "vitest";
import {
  compareFunctionSpec,
  compareSchema,
  getLatestOutputProjectDir,
  listTable,
  pollUntil,
  responseAdminClient,
  responseClient,
} from "../../../grader";
import { anyApi } from "convex/server";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import ts from "typescript";

const CATEGORY = "007-components";
const EVAL_NAME = "010-workpool_completion_tracking";

// USAGE eval (full pipeline): the task names @convex-dev/workpool and ships
// its API sheet; this grader checks correct wiring. Behavior: every enqueued
// job - including one that deterministically throws - must land exactly one
// receipt via the pool's onComplete callback (verified empirically: workpool
// 0.4.8 fires onComplete once with result.kind "failed" for a throwing
// mutation; mutations are never retried by the pool). Static checks are
// call-path-connected: submitJobs -> (helpers) -> pool.enqueue* carrying an
// onComplete reference, the pool bound to the mounted component with
// maxParallelism 2, and receipts written ONLY by the completion callback -
// a job cannot write its own failure receipt, and an optimistic write in
// submitJobs would defeat the completion-tracking concept.

// ── Module model: per-file symbol tracking with import resolution ──────

type ModuleInfo = {
  /** convex-relative, extensionless, "/"-separated (e.g. "index", "lib/pool") */
  path: string;
  sourceFile: ts.SourceFile;
  /** identifier (or `ns.member`) -> initializer, file-scoped */
  constDecls: Map<string, ts.Expression>;
  /** local names bound to the Workpool class from @convex-dev/workpool */
  workpoolClassNames: Set<string>;
  /** `import * as wp from "@convex-dev/workpool"` namespaces */
  workpoolNamespaces: Set<string>;
  /** local aliases of `components` from ../_generated/api */
  componentsAliases: Set<string>;
  /** identifiers destructured from a components alias -> component key */
  componentsDestructures: Map<string, string>;
  /** local aliases of `internal` / `api` from ../_generated/api */
  functionRefRoots: Set<string>;
  /** namespace imports of ../_generated/api (ns.components, ns.internal) */
  generatedApiNamespaces: Set<string>;
  /** local function name -> body-ish node, for call-path walking */
  localFunctions: Map<string, ts.Node>;
  /** named imports from sibling convex modules: local -> target */
  localImports: Map<string, { module: string; exportedName: string }>;
  /** namespace imports of sibling convex modules: ns -> module path */
  localNamespaceImports: Map<string, string>;
  /** pool variables constructed or imported into this file */
  poolVars: Map<string, PoolInfo>;
};

type PoolInfo = {
  optionsExpression: ts.Expression | undefined;
  module: ModuleInfo;
};

type Project = {
  modules: Map<string, ModuleInfo>;
  dependencies: Record<string, string>;
};

const GENERATED_API_SPEC = /(^|\/)_generated\/api(\.js)?$/;
const WORKPOOL_CONFIG_SPEC = /^@convex-dev\/workpool\/convex\.config(\.js)?$/;
const ENQUEUE_METHODS = new Set([
  "enqueue",
  "enqueueMutation",
  "enqueueAction",
  "enqueueQuery",
  "enqueueMutationBatch",
  "enqueueActionBatch",
  "enqueueQueryBatch",
]);
const DB_WRITE_METHODS = new Set(["insert", "patch", "replace", "delete"]);

function toPosix(path: string): string {
  return path.replaceAll("\\", "/");
}

function loadProject(): Project {
  const projectDir = getLatestOutputProjectDir(CATEGORY, EVAL_NAME);

  let dependencies: Record<string, string> = {};
  try {
    const packageJson = JSON.parse(
      readFileSync(join(projectDir, "package.json"), "utf-8"),
    ) as { dependencies?: Record<string, string> };
    dependencies = packageJson.dependencies ?? {};
  } catch {
    // Unparseable package.json; the pin test will report it.
  }

  const modules = new Map<string, ModuleInfo>();
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
      if (!entry.isFile() || !/\.tsx?$/.test(entry.name)) continue;
      const text = readFileSync(
        join(projectDir, "convex", relativePath),
        "utf-8",
      );
      const sourceFile = ts.createSourceFile(
        relativePath,
        text,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      );
      const path = relativePath.replace(/\.tsx?$/, "");
      modules.set(path, {
        path,
        sourceFile,
        constDecls: new Map(),
        workpoolClassNames: new Set(),
        workpoolNamespaces: new Set(),
        componentsAliases: new Set(),
        componentsDestructures: new Map(),
        functionRefRoots: new Set(),
        generatedApiNamespaces: new Set(),
        localFunctions: new Map(),
        localImports: new Map(),
        localNamespaceImports: new Map(),
        poolVars: new Map(),
      });
    }
  };
  load("");

  for (const module of modules.values()) analyzeModule(module, modules);
  for (const module of modules.values()) {
    collectPoolConstructions(module, modules);
  }
  propagatePoolBindings(modules);
  return { modules, dependencies };
}

function resolveLocalModulePath(
  fromPath: string,
  specifier: string,
  modules: Map<string, ModuleInfo>,
): string | undefined {
  const base = toPosix(
    normalize(join(dirname(`${fromPath}.ts`), specifier)),
  ).replace(/\.(ts|tsx|js|jsx|mts|mjs)$/, "");
  for (const candidate of [base, `${base}/index`]) {
    if (modules.has(candidate)) return candidate;
  }
  return undefined;
}

function analyzeModule(
  module: ModuleInfo,
  modules: Map<string, ModuleInfo>,
): void {
  for (const statement of module.sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      continue;
    }
    const spec = statement.moduleSpecifier.text;
    const clause = statement.importClause;
    const bindings = clause?.namedBindings;

    if (spec === "@convex-dev/workpool") {
      if (bindings !== undefined && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          if ((element.propertyName ?? element.name).text === "Workpool") {
            module.workpoolClassNames.add(element.name.text);
          }
        }
      } else if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
        module.workpoolNamespaces.add(bindings.name.text);
      }
      continue;
    }

    if (GENERATED_API_SPEC.test(spec)) {
      if (bindings !== undefined && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          const imported = (element.propertyName ?? element.name).text;
          if (imported === "components") {
            module.componentsAliases.add(element.name.text);
          }
          if (imported === "internal" || imported === "api") {
            module.functionRefRoots.add(element.name.text);
          }
        }
      } else if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
        module.generatedApiNamespaces.add(bindings.name.text);
      }
      continue;
    }

    if (spec.startsWith(".")) {
      const target = resolveLocalModulePath(module.path, spec, modules);
      if (target === undefined) continue;
      if (bindings !== undefined && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          module.localImports.set(element.name.text, {
            module: target,
            exportedName: (element.propertyName ?? element.name).text,
          });
        }
      } else if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
        module.localNamespaceImports.set(bindings.name.text, target);
      }
      if (clause?.name !== undefined) {
        module.localImports.set(clause.name.text, {
          module: target,
          exportedName: "default",
        });
      }
    }
  }

  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
      if (ts.isIdentifier(node.name)) {
        module.constDecls.set(node.name.text, node.initializer);
        if (
          ts.isArrowFunction(node.initializer) ||
          ts.isFunctionExpression(node.initializer)
        ) {
          module.localFunctions.set(node.name.text, node.initializer);
        }
      } else if (ts.isObjectBindingPattern(node.name)) {
        // const { myPool } = components; -> myPool is a component reference.
        const initializer = unwrap(node.initializer);
        if (
          ts.isIdentifier(initializer) &&
          module.componentsAliases.has(initializer.text)
        ) {
          for (const element of node.name.elements) {
            if (ts.isIdentifier(element.name)) {
              const key = element.propertyName;
              module.componentsDestructures.set(
                element.name.text,
                key !== undefined && ts.isIdentifier(key)
                  ? key.text
                  : element.name.text,
              );
            }
          }
        }
      }
    }
    if (
      ts.isFunctionDeclaration(node) &&
      node.name !== undefined &&
      node.body !== undefined
    ) {
      module.localFunctions.set(node.name.text, node);
    }
    ts.forEachChild(node, visit);
  };
  visit(module.sourceFile);
}

/**
 * Pool constructions declared in a file (component-bound only). Runs as a
 * second pass after every module's imports/aliases are known, so component
 * references resolved across modules are visible.
 */
function collectPoolConstructions(
  module: ModuleInfo,
  modules: Map<string, ModuleInfo>,
): void {
  const collectPools = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined
    ) {
      const info = poolConstructionInfo(module, node.initializer, modules);
      if (info !== undefined) module.poolVars.set(node.name.text, info);
    }
    ts.forEachChild(node, collectPools);
  };
  collectPools(module.sourceFile);
}

function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isAwaitExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

type Resolved = { module: ModuleInfo; expression: ts.Expression };

/**
 * Resolve an expression through parens/casts, file-local const aliases, and
 * named imports of consts from sibling convex modules.
 */
function resolveExpression(
  modules: Map<string, ModuleInfo>,
  module: ModuleInfo,
  expression: ts.Expression,
): Resolved {
  let current: Resolved = { module, expression };
  const seen = new Set<string>();
  for (let i = 0; i < 8; i++) {
    const unwrapped = unwrap(current.expression);
    if (unwrapped !== current.expression) {
      current = { module: current.module, expression: unwrapped };
      continue;
    }
    if (!ts.isIdentifier(current.expression)) break;
    const name = current.expression.text;
    const key = `${current.module.path}:${name}`;
    if (seen.has(key)) break;
    seen.add(key);
    const local = current.module.constDecls.get(name);
    if (local !== undefined && local !== current.expression) {
      current = { module: current.module, expression: local };
      continue;
    }
    const imported = current.module.localImports.get(name);
    const targetModule =
      imported === undefined ? undefined : modules.get(imported.module);
    const targetDecl = targetModule?.constDecls.get(
      imported?.exportedName ?? "",
    );
    if (targetModule !== undefined && targetDecl !== undefined) {
      current = { module: targetModule, expression: targetDecl };
      continue;
    }
    break;
  }
  return current;
}

function resolveStringLiteral(
  modules: Map<string, ModuleInfo>,
  module: ModuleInfo,
  expression: ts.Expression,
): string | undefined {
  const resolved = resolveExpression(modules, module, expression);
  return ts.isStringLiteralLike(resolved.expression)
    ? resolved.expression.text
    : undefined;
}

function isComponentReference(
  modules: Map<string, ModuleInfo>,
  module: ModuleInfo,
  expression: ts.Expression,
): boolean {
  const { module: m, expression: resolved } = resolveExpression(
    modules,
    module,
    expression,
  );
  if (
    ts.isIdentifier(resolved) &&
    m.componentsDestructures.has(resolved.text)
  ) {
    return true;
  }
  if (ts.isPropertyAccessExpression(resolved)) {
    let base: ts.Expression = resolved;
    while (ts.isPropertyAccessExpression(base)) base = base.expression;
    if (ts.isIdentifier(base)) {
      if (m.componentsAliases.has(base.text)) return true;
      // ns.components.workpool through a namespace import of _generated/api.
      if (
        m.generatedApiNamespaces.has(base.text) &&
        /\.components\./.test(resolved.getText())
      ) {
        return true;
      }
    }
  }
  // Pragmatic fallback mirroring the 004-009 skeletons.
  return resolved.getText().startsWith("components.");
}

function poolConstructionInfo(
  module: ModuleInfo,
  expression: ts.Expression,
  modules?: Map<string, ModuleInfo>,
): PoolInfo | undefined {
  const initializer = unwrap(expression);
  if (!ts.isNewExpression(initializer)) return undefined;
  // The pool only counts when constructed over the mounted component:
  // `new Workpool({} as any, ...)` queues nothing that can run.
  if (
    modules !== undefined &&
    (initializer.arguments?.[0] === undefined ||
      !isComponentReference(modules, module, initializer.arguments[0]))
  ) {
    return undefined;
  }
  const target = unwrap(initializer.expression);
  const isWorkpoolClass =
    (ts.isIdentifier(target) && module.workpoolClassNames.has(target.text)) ||
    (ts.isPropertyAccessExpression(target) &&
      target.name.text === "Workpool" &&
      ts.isIdentifier(target.expression) &&
      module.workpoolNamespaces.has(target.expression.text));
  if (!isWorkpoolClass) return undefined;
  return {
    optionsExpression: initializer.arguments?.[1],
    module,
  };
}

/** Propagate pool bindings through named imports/exports between modules. */
function propagatePoolBindings(modules: Map<string, ModuleInfo>): void {
  for (let iteration = 0; iteration < modules.size * 2 + 1; iteration++) {
    let changed = false;
    for (const module of modules.values()) {
      for (const [localName, imported] of module.localImports) {
        if (module.poolVars.has(localName)) continue;
        const target = modules.get(imported.module);
        const pool = target?.poolVars.get(imported.exportedName);
        if (pool !== undefined) {
          module.poolVars.set(localName, pool);
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
}

function poolInfoForReceiver(
  modules: Map<string, ModuleInfo>,
  module: ModuleInfo,
  receiver: ts.Expression,
): PoolInfo | undefined {
  const { module: m, expression: resolved } = resolveExpression(
    modules,
    module,
    receiver,
  );
  if (ts.isIdentifier(resolved)) return m.poolVars.get(resolved.text);
  if (
    ts.isPropertyAccessExpression(resolved) &&
    ts.isIdentifier(resolved.expression)
  ) {
    // pools.statsPool through a namespace import of a sibling module.
    const targetPath = m.localNamespaceImports.get(resolved.expression.text);
    const target =
      targetPath === undefined ? undefined : modules.get(targetPath);
    return target?.poolVars.get(resolved.name.text);
  }
  const direct = poolConstructionInfo(m, resolved, modules);
  return direct;
}

/**
 * Collect the top-level properties of the object-literal arguments of a
 * call starting at `fromIndex`, following const aliases and one level of
 * spreads. Positions before `fromIndex` are the function payload: an
 * option like `onComplete` placed inside `fnArgs` is silently ignored by
 * the workpool at runtime, so it must not count as configuration.
 */
function collectOptionProperties(
  modules: Map<string, ModuleInfo>,
  module: ModuleInfo,
  call: ts.CallExpression,
  fromIndex: number,
): Map<string, Resolved> {
  const properties = new Map<string, Resolved>();
  const addFrom = (m: ModuleInfo, expr: ts.Expression, depth: number) => {
    if (depth > 3) return;
    const resolved = resolveExpression(modules, m, expr);
    if (!ts.isObjectLiteralExpression(resolved.expression)) return;
    for (const property of resolved.expression.properties) {
      if (ts.isSpreadAssignment(property)) {
        addFrom(resolved.module, property.expression, depth + 1);
        continue;
      }
      if (
        property.name === undefined ||
        !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
      ) {
        continue;
      }
      const name = property.name.text;
      if (ts.isPropertyAssignment(property)) {
        properties.set(name, {
          module: resolved.module,
          expression: property.initializer,
        });
      } else if (ts.isShorthandPropertyAssignment(property)) {
        properties.set(name, {
          module: resolved.module,
          expression: property.name,
        });
      }
    }
  };
  for (const argument of call.arguments.slice(fromIndex)) {
    addFrom(module, argument, 0);
  }
  return properties;
}

function optionsProperties(
  modules: Map<string, ModuleInfo>,
  pool: PoolInfo,
): Map<string, Resolved> {
  const properties = new Map<string, Resolved>();
  if (pool.optionsExpression === undefined) return properties;
  const addFrom = (m: ModuleInfo, expr: ts.Expression, depth: number) => {
    if (depth > 3) return;
    const resolved = resolveExpression(modules, m, expr);
    if (!ts.isObjectLiteralExpression(resolved.expression)) return;
    for (const property of resolved.expression.properties) {
      if (ts.isSpreadAssignment(property)) {
        addFrom(resolved.module, property.expression, depth + 1);
        continue;
      }
      if (
        property.name === undefined ||
        !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
      ) {
        continue;
      }
      if (ts.isPropertyAssignment(property)) {
        properties.set(property.name.text, {
          module: resolved.module,
          expression: property.initializer,
        });
      } else if (ts.isShorthandPropertyAssignment(property)) {
        properties.set(property.name.text, {
          module: resolved.module,
          expression: property.name,
        });
      }
    }
  };
  addFrom(pool.module, pool.optionsExpression, 0);
  return properties;
}

/** Resolve internal.foo.bar / api.foo.bar to { module, exportName }. */
function resolveFunctionReference(
  modules: Map<string, ModuleInfo>,
  module: ModuleInfo,
  expression: ts.Expression,
): { module: ModuleInfo; exportName: string } | undefined {
  let { module: m, expression: resolved } = resolveExpression(
    modules,
    module,
    expression,
  );
  // createFunctionHandle(internal.foo.bar) hands through the reference.
  if (ts.isCallExpression(resolved) && resolved.arguments[0] !== undefined) {
    ({ module: m, expression: resolved } = resolveExpression(
      modules,
      m,
      resolved.arguments[0],
    ));
  }
  const segments: string[] = [];
  let current: ts.Expression = resolved;
  while (ts.isPropertyAccessExpression(current)) {
    segments.unshift(current.name.text);
    current = current.expression;
  }
  if (!ts.isIdentifier(current)) return undefined;
  if (
    m.generatedApiNamespaces.has(current.text) &&
    (segments[0] === "internal" || segments[0] === "api")
  ) {
    segments.shift();
  } else if (!m.functionRefRoots.has(current.text)) {
    return undefined;
  }
  if (segments.length < 2) return undefined;
  const exportName = segments.pop()!;
  const target = modules.get(segments.join("/"));
  if (target === undefined) return undefined;
  return { module: target, exportName };
}

/** Find the top-level declaration node for an exported name in a module. */
function findExportedDeclaration(
  module: ModuleInfo,
  exportName: string,
): ts.Node | undefined {
  for (const statement of module.sourceFile.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (
          ts.isIdentifier(declaration.name) &&
          declaration.name.text === exportName
        ) {
          return declaration;
        }
      }
    }
    if (
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === exportName
    ) {
      return statement;
    }
  }
  return undefined;
}

/** Does this call write the given table (insert/patch/replace/delete)? */
function isTableWrite(
  modules: Map<string, ModuleInfo>,
  module: ModuleInfo,
  call: ts.CallExpression,
  table: string,
): boolean {
  if (!ts.isPropertyAccessExpression(call.expression)) return false;
  if (!DB_WRITE_METHODS.has(call.expression.name.text)) return false;
  const first = call.arguments[0];
  return (
    first !== undefined &&
    resolveStringLiteral(modules, module, first) === table
  );
}

/**
 * Walk a region (function body or declaration), following calls into local
 * helper functions (same module or imported sibling modules), invoking the
 * visitor for every call expression encountered.
 */
function walkCalls(
  modules: Map<string, ModuleInfo>,
  module: ModuleInfo,
  region: ts.Node,
  visit: (call: ts.CallExpression, module: ModuleInfo) => void,
  depth = 0,
  walked = new Set<ts.Node>(),
  onRegion?: (module: ModuleInfo, region: ts.Node) => void,
): void {
  if (depth > 5 || walked.has(region)) return;
  walked.add(region);
  onRegion?.(module, region);
  const step = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      visit(node, module);
      const callee = unwrap(node.expression);
      if (ts.isIdentifier(callee)) {
        const local = module.localFunctions.get(callee.text);
        if (local !== undefined) {
          walkCalls(modules, module, local, visit, depth + 1, walked, onRegion);
        }
        const imported = module.localImports.get(callee.text);
        const target =
          imported === undefined ? undefined : modules.get(imported.module);
        const targetFn = target?.localFunctions.get(
          imported?.exportedName ?? "",
        );
        if (target !== undefined && targetFn !== undefined) {
          walkCalls(
            modules,
            target,
            targetFn,
            visit,
            depth + 1,
            walked,
            onRegion,
          );
        }
      } else if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression)
      ) {
        const targetPath = module.localNamespaceImports.get(
          callee.expression.text,
        );
        const target =
          targetPath === undefined ? undefined : modules.get(targetPath);
        const targetFn = target?.localFunctions.get(callee.name.text);
        if (target !== undefined && targetFn !== undefined) {
          walkCalls(
            modules,
            target,
            targetFn,
            visit,
            depth + 1,
            walked,
            onRegion,
          );
        }
      }
    }
    ts.forEachChild(node, step);
  };
  step(region);
}

/** Find the handler node of an exported Convex function declaration. */
function findHandler(
  modules: Map<string, ModuleInfo>,
  functionName: string,
): { module: ModuleInfo; handler: ts.Node } | undefined {
  for (const module of modules.values()) {
    const declaration = findExportedDeclaration(module, functionName);
    if (
      declaration === undefined ||
      !ts.isVariableDeclaration(declaration) ||
      declaration.initializer === undefined
    ) {
      continue;
    }
    const initializer = unwrap(declaration.initializer);
    if (!ts.isCallExpression(initializer) || initializer.arguments.length < 1) {
      continue;
    }
    const config = unwrap(initializer.arguments[0]);
    if (!ts.isObjectLiteralExpression(config)) continue;
    for (const property of config.properties) {
      const isHandler =
        property.name !== undefined &&
        ts.isIdentifier(property.name) &&
        property.name.text === "handler";
      if (ts.isPropertyAssignment(property) && isHandler) {
        const handler = resolveExpression(
          modules,
          module,
          property.initializer,
        );
        return { module: handler.module, handler: handler.expression };
      }
      if (ts.isMethodDeclaration(property) && isHandler && property.body) {
        return { module, handler: property.body };
      }
    }
  }
  return undefined;
}

// ── Numeric resolution ─────────────────────────────────────────────────

function evaluateNumeric(
  modules: Map<string, ModuleInfo>,
  module: ModuleInfo,
  expression: ts.Expression,
  depth = 0,
): number | undefined {
  if (depth > 6) return undefined;
  const resolved = resolveExpression(modules, module, expression);
  const value = resolved.expression;
  if (ts.isNumericLiteral(value)) return Number(value.text.replaceAll("_", ""));
  if (
    ts.isPrefixUnaryExpression(value) &&
    value.operator === ts.SyntaxKind.MinusToken
  ) {
    const operand = evaluateNumeric(
      modules,
      resolved.module,
      value.operand,
      depth + 1,
    );
    return operand === undefined ? undefined : -operand;
  }
  if (ts.isBinaryExpression(value)) {
    const left = evaluateNumeric(
      modules,
      resolved.module,
      value.left,
      depth + 1,
    );
    const right = evaluateNumeric(
      modules,
      resolved.module,
      value.right,
      depth + 1,
    );
    if (left === undefined || right === undefined) return undefined;
    if (value.operatorToken.kind === ts.SyntaxKind.AsteriskToken)
      return left * right;
    if (value.operatorToken.kind === ts.SyntaxKind.PlusToken)
      return left + right;
    if (value.operatorToken.kind === ts.SyntaxKind.MinusToken)
      return left - right;
  }
  return undefined;
}

/** The components.<key> a component reference points at, if resolvable. */
function componentKeyFor(
  modules: Map<string, ModuleInfo>,
  module: ModuleInfo,
  expression: ts.Expression,
): string | undefined {
  const { module: m, expression: resolved } = resolveExpression(
    modules,
    module,
    expression,
  );
  if (ts.isIdentifier(resolved)) {
    return m.componentsDestructures.get(resolved.text);
  }
  if (ts.isPropertyAccessExpression(resolved)) {
    const segments: string[] = [];
    let base: ts.Expression = resolved;
    while (ts.isPropertyAccessExpression(base)) {
      segments.unshift(base.name.text);
      base = base.expression;
    }
    if (ts.isIdentifier(base)) {
      if (m.componentsAliases.has(base.text) && segments.length >= 1) {
        return segments[0];
      }
      if (
        m.generatedApiNamespaces.has(base.text) &&
        segments[0] === "components" &&
        segments.length >= 2
      ) {
        return segments[1];
      }
      if (base.text === "components" && segments.length >= 1) {
        return segments[0];
      }
    }
  }
  return undefined;
}

// ── Eval-specific analysis ─────────────────────────────────────────────

interface Analysis {
  dependencies: Record<string, string>;
  mountNames: Set<string>;
  poolBoundToMount: boolean;
  poolMaxParallelismTwo: boolean;
  enqueuesWithOnCompleteOnPath: boolean;
  receiptsWriteCount: number;
  receiptsWritesOutsideOnComplete: string[];
  receiptsWritesReachableOutsideCompletion: string[];
  receiptsWriteOnSubmitJobsPath: boolean;
}

function analyze(): Analysis {
  const project = loadProject();
  const { modules } = project;

  // Mount names: each .use(...) whose argument is the imported workpool
  // convex.config mounts under its `name` option, or "workpool" by default.
  // A loose "imports the config + any .use(" match would also accept a file
  // that mounts some OTHER component, so the argument must resolve to the
  // workpool config binding.
  const mountNames = new Set<string>();
  for (const module of modules.values()) {
    const configLocals = new Set<string>();
    const configNamespaces = new Set<string>();
    for (const statement of module.sourceFile.statements) {
      if (
        !ts.isImportDeclaration(statement) ||
        !ts.isStringLiteral(statement.moduleSpecifier) ||
        !WORKPOOL_CONFIG_SPEC.test(statement.moduleSpecifier.text)
      ) {
        continue;
      }
      if (statement.importClause?.name !== undefined) {
        configLocals.add(statement.importClause.name.text);
      }
      const bindings = statement.importClause?.namedBindings;
      if (bindings !== undefined && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          if ((element.propertyName ?? element.name).text === "default") {
            configLocals.add(element.name.text);
          }
        }
      } else if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
        configNamespaces.add(bindings.name.text);
      }
    }
    if (configLocals.size === 0 && configNamespaces.size === 0) continue;
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "use" &&
        node.arguments[0] !== undefined
      ) {
        const argument = resolveExpression(
          modules,
          module,
          node.arguments[0],
        ).expression;
        const isWorkpoolConfig =
          (ts.isIdentifier(argument) && configLocals.has(argument.text)) ||
          (ts.isPropertyAccessExpression(argument) &&
            argument.name.text === "default" &&
            ts.isIdentifier(argument.expression) &&
            configNamespaces.has(argument.expression.text));
        if (isWorkpoolConfig) {
          let name = "workpool";
          const optionsArg = node.arguments[1];
          if (optionsArg !== undefined) {
            const options = resolveExpression(modules, module, optionsArg);
            if (ts.isObjectLiteralExpression(options.expression)) {
              for (const property of options.expression.properties) {
                if (
                  ts.isPropertyAssignment(property) &&
                  (ts.isIdentifier(property.name) ||
                    ts.isStringLiteral(property.name)) &&
                  property.name.text === "name"
                ) {
                  const value = resolveStringLiteral(
                    modules,
                    options.module,
                    property.initializer,
                  );
                  if (value !== undefined) name = value;
                }
              }
            }
          }
          mountNames.add(name);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(module.sourceFile);
  }

  // Pool constructions bound to a mounted component name, with the task's
  // maxParallelism: 2 statically resolvable.
  let poolBoundToMount = false;
  let poolMaxParallelismTwo = false;
  for (const module of modules.values()) {
    const visit = (node: ts.Node) => {
      if (ts.isNewExpression(node)) {
        const info = poolConstructionInfo(module, node);
        const componentArg = node.arguments?.[0];
        if (info !== undefined && componentArg !== undefined) {
          const key = componentKeyFor(modules, module, componentArg);
          if (key !== undefined && mountNames.has(key)) {
            poolBoundToMount = true;
            const maxParallelism = optionsProperties(modules, info).get(
              "maxParallelism",
            );
            if (
              maxParallelism !== undefined &&
              evaluateNumeric(
                modules,
                maxParallelism.module,
                maxParallelism.expression,
              ) === 2
            ) {
              poolMaxParallelismTwo = true;
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(module.sourceFile);
  }

  // Call-path analysis from submitJobs, plus a global sweep of enqueue
  // sites so every referenced completion handler contributes to the
  // allowed-receipts-writers set.
  let enqueuesWithOnCompleteOnPath = false;
  let receiptsWriteOnSubmitJobsPath = false;
  const onCompleteTargets = new Map<
    string,
    { module: ModuleInfo; exportName: string }
  >();

  const inspectEnqueue = (
    call: ts.CallExpression,
    module: ModuleInfo,
  ): { hasOnComplete: boolean } => {
    if (!ts.isPropertyAccessExpression(call.expression)) {
      return { hasOnComplete: false };
    }
    const method = call.expression.name.text;
    const isClientEnqueue =
      ENQUEUE_METHODS.has(method) &&
      poolInfoForReceiver(modules, module, call.expression.expression) !==
        undefined;
    const firstArg = call.arguments[0];
    const isRawEnqueue =
      (method === "runMutation" || method === "runAction") &&
      firstArg !== undefined &&
      /^components\./.test(firstArg.getText()) &&
      /\.enqueue/i.test(firstArg.getText());
    if (!isClientEnqueue && !isRawEnqueue) return { hasOnComplete: false };
    // Client form: (ctx, fn, fnArgs, options) - options live at index 3;
    // raw form: (ref, args) - the enqueue args object is index 1. An
    // onComplete inside the job payload is ignored by the workpool.
    const options = collectOptionProperties(
      modules,
      module,
      call,
      isClientEnqueue ? 3 : 1,
    );
    const onComplete = options.get("onComplete");
    if (onComplete === undefined) return { hasOnComplete: false };
    const target = resolveFunctionReference(
      modules,
      onComplete.module,
      onComplete.expression,
    );
    if (target !== undefined) {
      onCompleteTargets.set(
        `${target.module.path}:${target.exportName}`,
        target,
      );
    }
    return { hasOnComplete: true };
  };

  for (const module of modules.values()) {
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) inspectEnqueue(node, module);
      ts.forEachChild(node, visit);
    };
    visit(module.sourceFile);
  }

  const entry = findHandler(modules, "submitJobs");
  if (entry !== undefined) {
    walkCalls(modules, entry.module, entry.handler, (call, module) => {
      if (isTableWrite(modules, module, call, "receipts")) {
        receiptsWriteOnSubmitJobsPath = true;
      }
      if (inspectEnqueue(call, module).hasOnComplete) {
        enqueuesWithOnCompleteOnPath = true;
      }
    });
  }

  // Allowed receipts writers: each completion handler's declaration plus
  // the local helpers reachable from it.
  const allowedSpans: { module: ModuleInfo; start: number; end: number }[] = [];
  for (const target of onCompleteTargets.values()) {
    const declaration = findExportedDeclaration(
      target.module,
      target.exportName,
    );
    if (declaration === undefined) continue;
    walkCalls(
      modules,
      target.module,
      declaration,
      () => {},
      0,
      new Set(),
      (module, region) => {
        allowedSpans.push({
          module,
          start: region.getStart(),
          end: region.getEnd(),
        });
      },
    );
  }

  let receiptsWriteCount = 0;
  const receiptsWritesOutsideOnComplete: string[] = [];
  for (const module of modules.values()) {
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        isTableWrite(modules, module, node, "receipts")
      ) {
        receiptsWriteCount++;
        const inside = allowedSpans.some(
          (span) =>
            span.module === module &&
            node.getStart() >= span.start &&
            node.getEnd() <= span.end,
        );
        if (!inside) {
          receiptsWritesOutsideOnComplete.push(
            `${module.path}.ts: ${node.getText().slice(0, 80)}`,
          );
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(module.sourceFile);
  }

  // Span-allowlisting alone is not enough: a shared helper reachable from
  // the completion handler is inside an allowed span, yet the JOB could
  // call the same helper to record its own successes - behavioral counts
  // still come out exactly one per job, but receipts would no longer be
  // written only by completion bookkeeping. Sweep every other Convex
  // function's handler and flag any reachable receipts write.
  const completionKeys = new Set(onCompleteTargets.keys());
  const receiptsWritesReachableOutsideCompletion: string[] = [];
  for (const module of modules.values()) {
    for (const statement of module.sourceFile.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (
          !ts.isIdentifier(declaration.name) ||
          declaration.initializer === undefined ||
          completionKeys.has(`${module.path}:${declaration.name.text}`)
        ) {
          continue;
        }
        const initializer = unwrap(declaration.initializer);
        if (
          !ts.isCallExpression(initializer) ||
          initializer.arguments[0] === undefined
        ) {
          continue;
        }
        const config = unwrap(initializer.arguments[0]);
        if (!ts.isObjectLiteralExpression(config)) continue;
        const hasHandler = config.properties.some(
          (property) =>
            property.name !== undefined &&
            ts.isIdentifier(property.name) &&
            property.name.text === "handler",
        );
        if (!hasHandler) continue;
        walkCalls(modules, module, declaration, (call, callModule) => {
          if (isTableWrite(modules, callModule, call, "receipts")) {
            receiptsWritesReachableOutsideCompletion.push(
              `${module.path}.ts: ${declaration.name.getText()} reaches ${call
                .getText()
                .slice(0, 60)}`,
            );
          }
        });
      }
    }
  }

  return {
    dependencies: project.dependencies,
    mountNames,
    poolBoundToMount,
    poolMaxParallelismTwo,
    enqueuesWithOnCompleteOnPath,
    receiptsWriteCount,
    receiptsWritesOutsideOnComplete,
    receiptsWritesReachableOutsideCompletion,
    receiptsWriteOnSubmitJobsPath,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────

test("compare schema", async ({ skip }) => {
  await compareSchema(skip);
});

test("compare function spec", async ({ skip }) => {
  // The task dictates only the public surface; the job and onComplete
  // handler are internal functions whose names/modules are the model's
  // business, and return validators stay optional.
  await compareFunctionSpec(skip, { ignoreReturns: true, publicOnly: true });
});

type ReceiptRow = { jobKey: string; kind: string; value: number | null };

function receiptsFor(rows: ReceiptRow[], jobKey: string): ReceiptRow[] {
  return rows.filter((row) => row.jobKey === jobKey);
}

function expectSingleSuccess(
  rows: ReceiptRow[],
  jobKey: string,
  value: number,
) {
  const matching = receiptsFor(rows, jobKey);
  expect(matching, `job ${jobKey} must have exactly one receipt`).toHaveLength(
    1,
  );
  expect(matching[0].kind, `job ${jobKey} succeeded`).toBe("success");
  expect(matching[0].value, `job ${jobKey} computes its square`).toBe(value);
}

// One ordered flow: receipts accumulate and the second batch doubles as the
// settle window proving the first batch stayed exactly-once (a duplicate
// onComplete would surface as an extra row by the time batch 2 lands).
test(
  "every job lands exactly one receipt, including the poisoned one",
  { timeout: 150_000 },
  async () => {
    const receiptRows = async (): Promise<ReceiptRow[]> =>
      (await listTable(responseAdminClient, "receipts", 200)) as ReceiptRow[];

    expect(await receiptRows()).toHaveLength(0);

    await responseClient.mutation(anyApi.index.submitJobs, {
      inputs: [3, 5, -1, 10, 0],
    });
    await pollUntil(async () => (await receiptRows()).length >= 5, {
      timeoutMs: 60_000,
      intervalMs: 500,
    });
    const afterFirstBatch = await receiptRows();
    expect(
      afterFirstBatch,
      "exactly one receipt per submitted job",
    ).toHaveLength(5);
    expectSingleSuccess(afterFirstBatch, "3", 9);
    expectSingleSuccess(afterFirstBatch, "5", 25);
    expectSingleSuccess(afterFirstBatch, "10", 100);
    expectSingleSuccess(afterFirstBatch, "0", 0);
    const poisoned = receiptsFor(afterFirstBatch, "-1");
    expect(
      poisoned,
      "the throwing job must record failed exactly once",
    ).toHaveLength(1);
    expect(poisoned[0].kind).toBe("failed");
    expect(poisoned[0].value, "failed receipts carry a null value").toBeNull();

    // Second batch: repeatability, and the settle window for batch 1.
    await responseClient.mutation(anyApi.index.submitJobs, {
      inputs: [7, -1],
    });
    await pollUntil(async () => (await receiptRows()).length >= 7, {
      timeoutMs: 60_000,
      intervalMs: 500,
    });
    const afterSecondBatch = await receiptRows();
    expect(
      afterSecondBatch,
      "no duplicate or missing receipts across batches",
    ).toHaveLength(7);
    expectSingleSuccess(afterSecondBatch, "7", 49);
    const poisonedAll = receiptsFor(afterSecondBatch, "-1");
    expect(
      poisonedAll,
      "one failed receipt per poisoned submission - never retried, never duplicated",
    ).toHaveLength(2);
    for (const receipt of poisonedAll) {
      expect(receipt.kind).toBe("failed");
      expect(receipt.value).toBeNull();
    }
    // Batch 1 receipts must be untouched.
    expectSingleSuccess(afterSecondBatch, "3", 9);
    expectSingleSuccess(afterSecondBatch, "5", 25);
    expectSingleSuccess(afterSecondBatch, "10", 100);
    expectSingleSuccess(afterSecondBatch, "0", 0);
  },
);

const analysis = analyze();

test("pins the workpool component and its runtime peer exactly", () => {
  expect(analysis.dependencies["@convex-dev/workpool"]).toBe("0.4.8");
  expect(analysis.dependencies["convex"]).toBe("1.41.0");
  expect(analysis.dependencies["convex-helpers"]).toBe("0.1.111");
});

test("mounts the workpool and binds a maxParallelism-2 pool to it", () => {
  expect(
    analysis.mountNames.size,
    "convex.config.ts must mount @convex-dev/workpool/convex.config",
  ).toBeGreaterThanOrEqual(1);
  expect(
    analysis.poolBoundToMount,
    "the Workpool must be constructed over the mounted components.<name>",
  ).toBe(true);
  expect(
    analysis.poolMaxParallelismTwo,
    "the pool must set maxParallelism: 2",
  ).toBe(true);
});

test("submitJobs enqueues through the pool with an onComplete callback", () => {
  expect(analysis.enqueuesWithOnCompleteOnPath).toBe(true);
});

test("only the onComplete callback writes receipts", () => {
  expect(
    analysis.receiptsWriteCount,
    "the completion callback must insert receipts",
  ).toBeGreaterThanOrEqual(1);
  expect(
    analysis.receiptsWritesOutsideOnComplete,
    "receipts writes outside the completion handler defeat completion tracking",
  ).toEqual([]);
  expect(
    analysis.receiptsWritesReachableOutsideCompletion,
    "no other Convex function may reach a receipts write - a job recording its own successes defeats completion tracking",
  ).toEqual([]);
  expect(
    analysis.receiptsWriteOnSubmitJobsPath,
    "submitJobs must not write receipts synchronously",
  ).toBe(false);
});
