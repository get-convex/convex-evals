import { expect, test } from "vitest";
import { getLatestOutputProjectDir } from "../../../grader/outputDir";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import ts from "typescript";

const CATEGORY = "007-components";
const EVAL_NAME = "013-choose_workpool_completion";

// SELECTION eval, static pipeline (see eval.json): measures whether the
// model CHOSE the workpool component for completion bookkeeping (onComplete
// firing for success AND failure), tolerant of syntax/version/API noise.
// Correct invocation is graded by the usage eval (010), not here. Checks are
// call-path-connected: startProcessing -> (helpers) -> pool.enqueue* with an
// onComplete reference -> audit write inside that completion handler.

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
  /** identifiers destructured from a components alias */
  componentsDestructures: Set<string>;
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
  dependsOnWorkpool: boolean;
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

  let dependsOnWorkpool = false;
  try {
    const packageJson = JSON.parse(
      readFileSync(join(projectDir, "package.json"), "utf-8"),
    ) as { dependencies?: Record<string, string> };
    dependsOnWorkpool =
      packageJson.dependencies?.["@convex-dev/workpool"] !== undefined;
  } catch {
    // Unparseable package.json: choice not visible.
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
        componentsDestructures: new Set(),
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
  return { modules, dependsOnWorkpool };
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
          // Any named import can serve as the client class (mirrors the
          // 004-009 skeletons): selection grading tolerates typo'd or
          // stale class names - construction over components.* is what
          // proves the choice, and only a class is ever `new`-ed.
          module.workpoolClassNames.add(element.name.text);
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
              module.componentsDestructures.add(element.name.text);
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
): void {
  if (depth > 5 || walked.has(region)) return;
  walked.add(region);
  const step = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      visit(node, module);
      const callee = unwrap(node.expression);
      if (ts.isIdentifier(callee)) {
        const local = module.localFunctions.get(callee.text);
        if (local !== undefined) {
          walkCalls(modules, module, local, visit, depth + 1, walked);
        }
        const imported = module.localImports.get(callee.text);
        const target =
          imported === undefined ? undefined : modules.get(imported.module);
        const targetFn = target?.localFunctions.get(
          imported?.exportedName ?? "",
        );
        if (target !== undefined && targetFn !== undefined) {
          walkCalls(modules, target, targetFn, visit, depth + 1, walked);
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
          walkCalls(modules, target, targetFn, visit, depth + 1, walked);
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

// ── Eval-specific analysis ─────────────────────────────────────────────

interface Analysis {
  dependsOnWorkpool: boolean;
  mountsWorkpool: boolean;
  wiresPool: boolean;
  enqueuesWithOnComplete: boolean;
  enqueuedJobDoesDatabaseWork: boolean;
  auditWriteInsideOnComplete: boolean;
  auditWriteOnStartProcessingPath: boolean;
  auditWriteReachableOutsideCompletion: boolean;
}

function analyze(): Analysis {
  const project = loadProject();
  const { modules } = project;

  // Mount: a .use(...) whose argument is the imported workpool convex.config.
  let mountsWorkpool = false;
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
        if (
          (ts.isIdentifier(argument) && configLocals.has(argument.text)) ||
          (ts.isPropertyAccessExpression(argument) &&
            argument.name.text === "default" &&
            ts.isIdentifier(argument.expression) &&
            configNamespaces.has(argument.expression.text))
        ) {
          mountsWorkpool = true;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(module.sourceFile);
  }

  // Wiring: a Workpool constructed over components.* (the mounted component).
  let wiresPool = false;
  for (const module of modules.values()) {
    const visit = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
        const initializer = unwrap(node.initializer);
        if (
          ts.isNewExpression(initializer) &&
          poolConstructionInfo(module, initializer) !== undefined &&
          initializer.arguments?.[0] !== undefined &&
          isComponentReference(modules, module, initializer.arguments[0])
        ) {
          wiresPool = true;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(module.sourceFile);
  }

  // Call-path analysis from startProcessing.
  let enqueuesWithOnComplete = false;
  let enqueuedJobDoesDatabaseWork = false;
  let auditWriteInsideOnComplete = false;
  let auditWriteOnStartProcessingPath = false;
  const onCompleteTargets = new Map<
    string,
    { module: ModuleInfo; exportName: string }
  >();

  const entry = findHandler(modules, "startProcessing");
  if (entry !== undefined) {
    walkCalls(modules, entry.module, entry.handler, (call, module) => {
      if (isTableWrite(modules, module, call, "auditLog")) {
        auditWriteOnStartProcessingPath = true;
      }
      if (!ts.isPropertyAccessExpression(call.expression)) return;
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
      if (!isClientEnqueue && !isRawEnqueue) return;
      // Client form: (ctx, fn, fnArgs, options) - options live at index 3;
      // raw form: (ref, args) - the enqueue args object is index 1.
      const options = collectOptionProperties(
        modules,
        module,
        call,
        isClientEnqueue ? 3 : 1,
      );
      const onComplete = options.get("onComplete");
      if (onComplete === undefined) return;
      enqueuesWithOnComplete = true;
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
      // The completion callback must wrap the actual upload processor: a
      // no-op job with recordOutcome attached (processUpload left unused)
      // would track completions of nothing. Resolve the enqueued function
      // and require database work on its call path - form-agnostic, since
      // the classic ctx.db.patch(id, ...) form carries no table string.
      const jobExpression = isClientEnqueue
        ? call.arguments[1]
        : options.get("fnHandle")?.expression;
      const jobModule = isClientEnqueue
        ? module
        : (options.get("fnHandle")?.module ?? module);
      const job =
        jobExpression === undefined
          ? undefined
          : resolveFunctionReference(modules, jobModule, jobExpression);
      const jobDeclaration =
        job === undefined
          ? undefined
          : findExportedDeclaration(job.module, job.exportName);
      if (job !== undefined && jobDeclaration !== undefined) {
        walkCalls(modules, job.module, jobDeclaration, (jobCall) => {
          if (
            ts.isPropertyAccessExpression(jobCall.expression) &&
            DB_WRITE_METHODS.has(jobCall.expression.name.text)
          ) {
            enqueuedJobDoesDatabaseWork = true;
          }
        });
      }
    });
  }

  // The audit row must be written inside a completion handler's own call
  // path (its declaration, or local helpers it calls).
  for (const target of onCompleteTargets.values()) {
    const declaration = findExportedDeclaration(
      target.module,
      target.exportName,
    );
    if (declaration === undefined) continue;
    let writes = false;
    walkCalls(modules, target.module, declaration, (call, module) => {
      if (isTableWrite(modules, module, call, "auditLog")) writes = true;
    });
    if (writes) auditWriteInsideOnComplete = true;
  }

  // The task rules out jobs recording their own outcome ("a failed job
  // cannot write its own audit row"): sweep every Convex function handler
  // other than the resolved completion handlers - through local and
  // cross-module helpers - and flag any reachable auditLog write. This
  // kills the shared-helper pattern where processUpload writes success
  // rows and the callback only failures.
  let auditWriteReachableOutsideCompletion = false;
  for (const module of modules.values()) {
    for (const statement of module.sourceFile.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (
          !ts.isIdentifier(declaration.name) ||
          declaration.initializer === undefined ||
          onCompleteTargets.has(`${module.path}:${declaration.name.text}`)
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
          if (isTableWrite(modules, callModule, call, "auditLog")) {
            auditWriteReachableOutsideCompletion = true;
          }
        });
      }
    }
  }

  return {
    dependsOnWorkpool: project.dependsOnWorkpool,
    mountsWorkpool,
    wiresPool,
    enqueuesWithOnComplete,
    enqueuedJobDoesDatabaseWork,
    auditWriteInsideOnComplete,
    auditWriteOnStartProcessingPath,
    auditWriteReachableOutsideCompletion,
  };
}

const analysis = analyze();

test("chooses the workpool component as a dependency", () => {
  expect(analysis.dependsOnWorkpool).toBe(true);
});

test("mounts the component in the app config", () => {
  expect(analysis.mountsWorkpool).toBe(true);
});

test("constructs a Workpool over the mounted component", () => {
  expect(analysis.wiresPool).toBe(true);
});

test("startProcessing enqueues the job with an onComplete callback", () => {
  expect(analysis.enqueuesWithOnComplete).toBe(true);
  expect(
    analysis.enqueuedJobDoesDatabaseWork,
    "the completion callback must wrap the upload processor - a job that does no database work leaves uploads unprocessed",
  ).toBe(true);
});

test("only the completion callback writes audit rows", () => {
  expect(analysis.auditWriteInsideOnComplete).toBe(true);
  expect(analysis.auditWriteOnStartProcessingPath).toBe(false);
  expect(
    analysis.auditWriteReachableOutsideCompletion,
    "no other Convex function may reach an auditLog write - a job recording its own successes defeats completion bookkeeping",
  ).toBe(false);
});
