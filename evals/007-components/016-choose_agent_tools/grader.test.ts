import { expect, test } from "vitest";
import { getLatestOutputProjectDir } from "../../../grader/outputDir";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const CATEGORY = "007-components";
const EVAL_NAME = "016-choose_agent_tools";

// SELECTION eval, static pipeline (see eval.json): measures whether the
// model CHOSE the agent component for an assistant that
// answers via LLM tool calls recorded in a durable conversation,
// tolerant of syntax, version, and API-shape noise. Correct wiring is
// graded by the usage eval (014). The TypeScript parser is
// error-recovering, so choices stay visible even in code that would not
// compile.

const ENDPOINTS = ["openThread", "askAssistant"] as const;

type EndpointName = (typeof ENDPOINTS)[number];

const GENERATION_METHODS = new Set([
  "generateText",
  "streamText",
  "generateObject",
  "streamObject",
]);

/** One `new Agent(components.*, {...})` construction (or a factory-derived
 * instance of one), keyed by source position. */
interface AgentCtor {
  key: string;
  /** resolved `name` option (for factory instances, possibly derived from
   * the factory call's first string-literal argument) */
  name: string | undefined;
  options: ts.ObjectLiteralExpression | undefined;
}

interface PathFacts {
  threadCreate: boolean;
  componentSave: boolean;
  componentList: boolean;
  /** ctor key -> name, for generation calls that are actually
   * thread-scoped: a `{ threadId }` scope argument on an agent instance,
   * or a generate/stream on the thread returned by
   * `continueThread({ threadId })` (variable-bound or inline-chained). */
  scopedGenerationInstances: Map<string, string | undefined>;
  /** a thread-scoped generation call on this path also overrides `tools`
   * with a defined tool */
  toolsOverrideAtGeneration: boolean;
}

interface Analysis {
  dependsOnAgent: boolean;
  mountsAgent: boolean;
  /** resolved `name` options across every Agent construction/instance */
  agentNames: (string | undefined)[];
  /** ctor keys whose constructor wires a defined tool into `tools` */
  instancesWithTools: Set<string>;
  toolWiredInConstructor: boolean;
  messageStoreTables: string[];
  endpoints: Partial<Record<EndpointName, PathFacts>>;
}

function emptyFacts(): PathFacts {
  return {
    threadCreate: false,
    componentSave: false,
    componentList: false,
    scopedGenerationInstances: new Map(),
    toolsOverrideAtGeneration: false,
  };
}

function isThreadScopedGeneration(facts: PathFacts): boolean {
  return facts.scopedGenerationInstances.size > 0;
}

function generatingInstances(
  facts: PathFacts,
): Map<string, string | undefined> {
  return new Map(facts.scopedGenerationInstances);
}

function analyze(): Analysis {
  const projectDir = getLatestOutputProjectDir(CATEGORY, EVAL_NAME);

  let dependsOnAgent = false;
  try {
    const packageJson = JSON.parse(
      readFileSync(join(projectDir, "package.json"), "utf-8"),
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    dependsOnAgent =
      packageJson.dependencies?.["@convex-dev/agent"] !== undefined ||
      packageJson.devDependencies?.["@convex-dev/agent"] !== undefined;
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

  // Global collections: models legitimately factor agents, tools, and
  // helpers into separate modules, so symbols are tracked across files;
  // same-named bindings are disambiguated by nearest preceding
  // declaration in the same file when resolving receivers.
  const agentImports = new Map<string, string>();
  const agentNamespaces = new Set<string>();
  const aiToolCtors = new Set<string>();
  const componentsAliases = new Set<string>(["components"]);
  const consts = new Map<string, ts.Expression>();
  const localFunctions = new Map<string, ts.Node>();
  const relativeImportAliases: Array<{ local: string; original: string }> = [];
  /** import-local-name -> imported the agent's convex.config default */
  const agentConfigImports = new Map<ts.SourceFile, Set<string>>();
  const agentConfigNamespaces = new Map<ts.SourceFile, Set<string>>();

  for (const sourceFile of sources) {
    agentConfigImports.set(sourceFile, new Set());
    agentConfigNamespaces.set(sourceFile, new Set());
    for (const statement of sourceFile.statements) {
      if (
        !ts.isImportDeclaration(statement) ||
        !ts.isStringLiteral(statement.moduleSpecifier)
      ) {
        continue;
      }
      const spec = statement.moduleSpecifier.text;
      const bindings = statement.importClause?.namedBindings;
      if (/^@convex-dev\/agent\/convex\.config(?:\.js)?$/.test(spec)) {
        const defaultImport = statement.importClause?.name;
        if (defaultImport !== undefined) {
          agentConfigImports.get(sourceFile)!.add(defaultImport.text);
        }
        if (bindings !== undefined && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            if ((element.propertyName ?? element.name).text === "default") {
              agentConfigImports.get(sourceFile)!.add(element.name.text);
            }
          }
        } else if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
          agentConfigNamespaces.get(sourceFile)!.add(bindings.name.text);
        }
      }
      if (spec === "@convex-dev/agent") {
        if (bindings !== undefined && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            agentImports.set(
              element.name.text,
              (element.propertyName ?? element.name).text,
            );
          }
        } else if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
          agentNamespaces.add(bindings.name.text);
        }
      }
      if (
        spec === "ai" &&
        bindings !== undefined &&
        ts.isNamedImports(bindings)
      ) {
        for (const element of bindings.elements) {
          if ((element.propertyName ?? element.name).text === "tool") {
            aiToolCtors.add(element.name.text);
          }
        }
      }
      if (spec.startsWith(".")) {
        if (bindings !== undefined && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            relativeImportAliases.push({
              local: element.name.text,
              original: (element.propertyName ?? element.name).text,
            });
            if (
              /_generated\/api/.test(spec) &&
              (element.propertyName ?? element.name).text === "components"
            ) {
              componentsAliases.add(element.name.text);
            }
          }
        }
      }
    }

    const collect = (node: ts.Node) => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer !== undefined
      ) {
        consts.set(node.name.text, node.initializer);
        const initializer = unwrapNode(node.initializer);
        if (
          ts.isArrowFunction(initializer) ||
          ts.isFunctionExpression(initializer)
        ) {
          localFunctions.set(node.name.text, initializer.body);
        }
      }
      if (
        ts.isFunctionDeclaration(node) &&
        node.name !== undefined &&
        node.body !== undefined
      ) {
        localFunctions.set(node.name.text, node.body);
      }
      ts.forEachChild(node, collect);
    };
    collect(sourceFile);
  }

  function unwrapNode(expression: ts.Expression): ts.Expression {
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

  function resolveExpr(expression: ts.Expression): ts.Expression {
    let current = expression;
    const seen = new Set<string>();
    for (let i = 0; i < 8; i++) {
      current = unwrapNode(current);
      if (
        ts.isIdentifier(current) &&
        consts.has(current.text) &&
        !seen.has(current.text)
      ) {
        seen.add(current.text);
        current = consts.get(current.text)!;
      } else {
        break;
      }
    }
    return unwrapNode(current);
  }

  function objectLiteralOf(
    expression: ts.Expression,
  ): ts.ObjectLiteralExpression | undefined {
    const resolved = resolveExpr(expression);
    return ts.isObjectLiteralExpression(resolved) ? resolved : undefined;
  }

  /** Property value from an object literal, following shorthand
   * (`{ tools }`), string-literal names, and spreads of resolvable
   * objects. */
  function findOptionValue(
    expression: ts.Expression,
    propName: string,
    depth = 0,
  ): ts.Expression | undefined {
    const objectLiteral = objectLiteralOf(expression);
    if (objectLiteral === undefined) return undefined;
    let found: ts.Expression | undefined;
    for (const property of objectLiteral.properties) {
      if (
        ts.isShorthandPropertyAssignment(property) &&
        property.name.text === propName
      ) {
        found = property.name;
      }
      if (
        ts.isPropertyAssignment(property) &&
        (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
        property.name.text === propName
      ) {
        found = property.initializer;
      }
      if (ts.isSpreadAssignment(property) && depth < 2) {
        const inner = findOptionValue(property.expression, propName, depth + 1);
        if (inner !== undefined) found = inner;
      }
    }
    return found;
  }

  function objectHasProp(expression: ts.Expression, propName: string): boolean {
    return findOptionValue(expression, propName) !== undefined;
  }

  function stringLiteralOf(expression: ts.Expression): string | undefined {
    const resolved = resolveExpr(expression);
    return ts.isStringLiteralLike(resolved) ? resolved.text : undefined;
  }

  function rootIdentifier(expression: ts.Expression): string | undefined {
    let current: ts.Expression = unwrapNode(expression);
    for (let i = 0; i < 10; i++) {
      if (ts.isPropertyAccessExpression(current)) {
        current = current.expression;
      } else if (ts.isElementAccessExpression(current)) {
        current = current.expression;
      } else {
        break;
      }
    }
    return ts.isIdentifier(current) ? current.text : undefined;
  }

  /** Does the expression resolve to a `components.*` reference? */
  function isComponentsRef(expression: ts.Expression): boolean {
    const resolved = resolveExpr(expression);
    if (!ts.isPropertyAccessExpression(resolved)) return false;
    const root = rootIdentifier(resolved);
    return root !== undefined && componentsAliases.has(root);
  }

  // Mount: `.use(X)` where X resolves to the agent convex.config import.
  let mountsAgent = false;
  for (const sourceFile of sources) {
    const configImports = agentConfigImports.get(sourceFile)!;
    const configNamespaces = agentConfigNamespaces.get(sourceFile)!;
    if (configImports.size === 0 && configNamespaces.size === 0) continue;
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "use" &&
        node.arguments[0] !== undefined
      ) {
        const matchesConfig = (candidate: ts.Expression): boolean =>
          (ts.isIdentifier(candidate) && configImports.has(candidate.text)) ||
          (ts.isPropertyAccessExpression(candidate) &&
            candidate.name.text === "default" &&
            ts.isIdentifier(candidate.expression) &&
            configNamespaces.has(candidate.expression.text));
        // Match the raw argument first: import bindings are not consts, and
        // resolving the identifier through the global const table could
        // cross-wire with a same-named variable in another module (e.g. a
        // `const agent = new Agent(...)` instance). Only fall back to a
        // resolved alias when it was declared in this same config file.
        const direct = unwrapNode(node.arguments[0]);
        const resolved = resolveExpr(node.arguments[0]);
        if (
          matchesConfig(direct) ||
          (resolved.getSourceFile() === sourceFile && matchesConfig(resolved))
        ) {
          mountsAgent = true;
          return;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  function asAgentConstruction(
    expression: ts.Expression,
  ): ts.NewExpression | undefined {
    const initializer = resolveExpr(expression);
    if (!ts.isNewExpression(initializer)) return undefined;
    const callee = initializer.expression;
    const isCtor =
      (ts.isIdentifier(callee) && agentImports.get(callee.text) === "Agent") ||
      (ts.isPropertyAccessExpression(callee) &&
        callee.name.text === "Agent" &&
        ts.isIdentifier(callee.expression) &&
        agentNamespaces.has(callee.expression.text));
    if (!isCtor) return undefined;
    const firstArg = initializer.arguments?.[0];
    if (firstArg === undefined || !isComponentsRef(firstArg)) return undefined;
    return initializer;
  }

  function isToolish(expression: ts.Expression): boolean {
    const initializer = resolveExpr(expression);
    if (ts.isCallExpression(initializer)) {
      const callee = initializer.expression;
      if (ts.isIdentifier(callee)) {
        if (agentImports.get(callee.text) === "createTool") return true;
        if (aiToolCtors.has(callee.text)) return true;
      }
      if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        agentNamespaces.has(callee.expression.text) &&
        callee.name.text === "createTool"
      ) {
        return true;
      }
      return false;
    }
    // A plain AI-SDK tool object: an input schema plus an implementation.
    if (ts.isObjectLiteralExpression(initializer)) {
      const names = new Set<string>();
      for (const property of initializer.properties) {
        if (
          property.name !== undefined &&
          (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
        ) {
          names.add(property.name.text);
        }
      }
      return (
        (names.has("inputSchema") ||
          names.has("parameters") ||
          names.has("args")) &&
        (names.has("execute") || names.has("handler"))
      );
    }
    return false;
  }

  // ── construction sites, bindings, factories, thread vars, tools ─────

  const constructionsByKey = new Map<string, AgentCtor>();
  /** variable name -> bindings (instances OR continueThread thread vars) */
  const instanceBindings = new Map<
    string,
    Array<{ file: string; pos: number; ctor: AgentCtor }>
  >();
  const threadBindings = new Map<
    string,
    Array<{ file: string; pos: number; ctor: AgentCtor }>
  >();
  /** function name -> the construction its body returns */
  const factories = new Map<string, AgentCtor>();
  const toolVars = new Set<string>();

  function registerConstruction(
    construction: ts.NewExpression,
    sourceFile: ts.SourceFile,
  ): AgentCtor {
    const key = `${sourceFile.fileName}:${construction.pos}`;
    const existing = constructionsByKey.get(key);
    if (existing !== undefined) return existing;
    const optionsArg = construction.arguments?.[1];
    const options =
      optionsArg === undefined ? undefined : objectLiteralOf(optionsArg);
    let name: string | undefined;
    if (options !== undefined) {
      const nameValue = findOptionValue(options, "name");
      if (nameValue !== undefined) name = stringLiteralOf(nameValue);
    }
    const ctor: AgentCtor = { key, name, options };
    constructionsByKey.set(key, ctor);
    return ctor;
  }

  /** A factory call produces an instance; when the factory's own `name` is
   * dynamic, derive it from the call's first string-literal argument
   * (`makeAgent("TRIAGE")`). */
  function factoryInstance(
    call: ts.CallExpression,
    factoryCtor: AgentCtor,
    sourceFile: ts.SourceFile,
  ): AgentCtor {
    const key = `${sourceFile.fileName}:${call.pos}`;
    const existing = constructionsByKey.get(key);
    if (existing !== undefined) return existing;
    let name = factoryCtor.name;
    if (name === undefined) {
      for (const argument of call.arguments) {
        const literal = stringLiteralOf(argument);
        if (literal !== undefined) {
          name = literal;
          break;
        }
      }
    }
    const ctor: AgentCtor = { key, name, options: factoryCtor.options };
    constructionsByKey.set(key, ctor);
    return ctor;
  }

  function bindTo(
    bindings: Map<
      string,
      Array<{ file: string; pos: number; ctor: AgentCtor }>
    >,
    varName: string,
    file: string,
    pos: number,
    ctor: AgentCtor,
  ): void {
    const entries = bindings.get(varName) ?? [];
    if (!entries.some((entry) => entry.file === file && entry.pos === pos)) {
      entries.push({ file, pos, ctor });
    }
    bindings.set(varName, entries);
  }

  /** The construction a function body returns, ignoring nested functions. */
  function constructionReturnedBy(
    body: ts.Node,
    sourceFile: ts.SourceFile,
  ): AgentCtor | undefined {
    if (!ts.isBlock(body)) {
      const construction = asAgentConstruction(body as ts.Expression);
      if (construction !== undefined) {
        return registerConstruction(construction, sourceFile);
      }
      return undefined;
    }
    let found: AgentCtor | undefined;
    const visit = (node: ts.Node) => {
      if (found !== undefined) return;
      if (node !== body && ts.isFunctionLike(node)) return;
      if (ts.isReturnStatement(node) && node.expression !== undefined) {
        const construction = asAgentConstruction(node.expression);
        if (construction !== undefined) {
          found = registerConstruction(construction, sourceFile);
          return;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(body);
    return found;
  }

  /** Is this call `<instance>.continueThread(..., { threadId })`? */
  function continueThreadTarget(
    call: ts.CallExpression,
    sourceFile: ts.SourceFile,
  ): AgentCtor | undefined {
    if (
      !ts.isPropertyAccessExpression(call.expression) ||
      call.expression.name.text !== "continueThread"
    ) {
      return undefined;
    }
    if (
      !call.arguments.some((argument) => objectHasProp(argument, "threadId"))
    ) {
      return undefined;
    }
    return resolveInstance(call.expression.expression, sourceFile, call.pos);
  }

  // Pass A: construction sites, factories, tool definitions.
  for (const sourceFile of sources) {
    const collect = (node: ts.Node) => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer !== undefined
      ) {
        const initializer = unwrapNode(node.initializer);
        if (ts.isNewExpression(initializer)) {
          const construction = asAgentConstruction(initializer);
          if (construction !== undefined) {
            const ctor = registerConstruction(construction, sourceFile);
            bindTo(
              instanceBindings,
              node.name.text,
              sourceFile.fileName,
              node.pos,
              ctor,
            );
          }
        }
        if (
          ts.isArrowFunction(initializer) ||
          ts.isFunctionExpression(initializer)
        ) {
          const ctor = constructionReturnedBy(initializer.body, sourceFile);
          if (ctor !== undefined) factories.set(node.name.text, ctor);
        }
        if (isToolish(node.initializer)) {
          toolVars.add(node.name.text);
        }
      }
      if (
        ts.isFunctionDeclaration(node) &&
        node.name !== undefined &&
        node.body !== undefined
      ) {
        const ctor = constructionReturnedBy(node.body, sourceFile);
        if (ctor !== undefined) factories.set(node.name.text, ctor);
      }
      ts.forEachChild(node, collect);
    };
    collect(sourceFile);
  }

  // Pass B: factory-result variables and continueThread thread bindings.
  for (const sourceFile of sources) {
    const collect = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
        const initializer = unwrapNode(node.initializer);

        if (ts.isIdentifier(node.name)) {
          if (
            ts.isCallExpression(initializer) &&
            ts.isIdentifier(initializer.expression)
          ) {
            const factory = factories.get(initializer.expression.text);
            if (factory !== undefined) {
              bindTo(
                instanceBindings,
                node.name.text,
                sourceFile.fileName,
                node.pos,
                factoryInstance(initializer, factory, sourceFile),
              );
            }
          }
          // const t = (await agent.continueThread(ctx, { threadId })).thread
          if (
            ts.isPropertyAccessExpression(initializer) &&
            initializer.name.text === "thread"
          ) {
            const inner = unwrapNode(initializer.expression);
            if (ts.isCallExpression(inner)) {
              const target = continueThreadTarget(inner, sourceFile);
              if (target !== undefined) {
                bindTo(
                  threadBindings,
                  node.name.text,
                  sourceFile.fileName,
                  node.pos,
                  target,
                );
              }
            }
          }
        }

        // const { thread } = await agent.continueThread(ctx, { threadId })
        if (
          ts.isObjectBindingPattern(node.name) &&
          ts.isCallExpression(initializer)
        ) {
          const target = continueThreadTarget(initializer, sourceFile);
          if (target !== undefined) {
            for (const element of node.name.elements) {
              const propertyName =
                element.propertyName !== undefined &&
                ts.isIdentifier(element.propertyName)
                  ? element.propertyName.text
                  : ts.isIdentifier(element.name)
                    ? element.name.text
                    : undefined;
              if (propertyName === "thread" && ts.isIdentifier(element.name)) {
                bindTo(
                  threadBindings,
                  element.name.text,
                  sourceFile.fileName,
                  node.pos,
                  target,
                );
              }
            }
          }
        }
      }
      ts.forEachChild(node, collect);
    };
    collect(sourceFile);
  }

  // Propagate instances/factories/tools through renamed relative imports.
  for (let hop = 0; hop < 3; hop++) {
    for (const { local, original } of relativeImportAliases) {
      const originalBindings = instanceBindings.get(original);
      if (originalBindings !== undefined && !instanceBindings.has(local)) {
        instanceBindings.set(local, originalBindings);
      }
      if (factories.has(original) && !factories.has(local)) {
        factories.set(local, factories.get(original)!);
      }
      if (toolVars.has(original)) toolVars.add(local);
    }
  }

  /** Resolve a receiver to an Agent construction. Same-named variables
   * (e.g. `const agent = ...` in two handlers) resolve to the nearest
   * preceding declaration in the same file. */
  function resolveInstance(
    expression: ts.Expression,
    sourceFile: ts.SourceFile,
    callPos: number,
  ): AgentCtor | undefined {
    const receiver = unwrapNode(expression);
    if (ts.isNewExpression(receiver)) {
      const construction = asAgentConstruction(receiver);
      if (construction !== undefined) {
        return registerConstruction(construction, sourceFile);
      }
    }
    if (ts.isCallExpression(receiver) && ts.isIdentifier(receiver.expression)) {
      const factory = factories.get(receiver.expression.text);
      if (factory !== undefined) {
        return factoryInstance(receiver, factory, sourceFile);
      }
    }
    if (ts.isIdentifier(receiver)) {
      return nearestBinding(
        instanceBindings,
        receiver.text,
        sourceFile,
        callPos,
      );
    }
    return undefined;
  }

  function nearestBinding(
    bindings: Map<
      string,
      Array<{ file: string; pos: number; ctor: AgentCtor }>
    >,
    varName: string,
    sourceFile: ts.SourceFile,
    callPos: number,
  ): AgentCtor | undefined {
    const entries = bindings.get(varName);
    if (entries === undefined || entries.length === 0) return undefined;
    const preceding = entries
      .filter(
        (entry) => entry.file === sourceFile.fileName && entry.pos <= callPos,
      )
      .sort((a, b) => b.pos - a.pos);
    if (preceding.length > 0) return preceding[0].ctor;
    return entries[0].ctor;
  }

  function toolsConfigReferencesTool(
    expression: ts.Expression,
    depth = 0,
  ): boolean {
    const objectLiteral = objectLiteralOf(expression);
    if (objectLiteral === undefined) return false;
    for (const property of objectLiteral.properties) {
      if (
        ts.isShorthandPropertyAssignment(property) &&
        toolVars.has(property.name.text)
      ) {
        return true;
      }
      if (ts.isPropertyAssignment(property)) {
        const value = unwrapNode(property.initializer);
        if (ts.isIdentifier(value) && toolVars.has(value.text)) return true;
        if (isToolish(value)) return true;
      }
      if (
        ts.isSpreadAssignment(property) &&
        depth < 2 &&
        toolsConfigReferencesTool(property.expression, depth + 1)
      ) {
        return true;
      }
    }
    return false;
  }

  // ── message-store table scan ─────────────────────────────────────────

  const messageStoreTables: string[] = [];
  for (const sourceFile of sources) {
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "defineTable" &&
        node.arguments[0] !== undefined &&
        ts.isObjectLiteralExpression(node.arguments[0])
      ) {
        const fields = new Set<string>();
        for (const property of node.arguments[0].properties) {
          if (
            (ts.isPropertyAssignment(property) ||
              ts.isShorthandPropertyAssignment(property)) &&
            (ts.isIdentifier(property.name) ||
              ts.isStringLiteral(property.name))
          ) {
            fields.add(property.name.text);
          }
        }
        const looksLikeMessageRow =
          fields.has("role") ||
          fields.has("content") ||
          ((fields.has("body") || fields.has("text")) &&
            (fields.has("threadId") || fields.has("conversationId")));
        if (looksLikeMessageRow) {
          messageStoreTables.push(
            `${sourceFile.fileName}: defineTable({ ${[...fields].join(", ")} })`,
          );
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  // ── endpoint handlers and call-path walking ──────────────────────────

  function isExportedDeclaration(
    declaration: ts.VariableDeclaration,
    sourceFile: ts.SourceFile,
  ): boolean {
    const statement = declaration.parent?.parent;
    if (
      statement !== undefined &&
      ts.isVariableStatement(statement) &&
      ts
        .getModifiers(statement)
        ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ===
        true
    ) {
      return true;
    }
    if (!ts.isIdentifier(declaration.name)) return false;
    const name = declaration.name.text;
    return sourceFile.statements.some(
      (candidate) =>
        ts.isExportDeclaration(candidate) &&
        candidate.exportClause !== undefined &&
        ts.isNamedExports(candidate.exportClause) &&
        candidate.exportClause.elements.some(
          (element) => (element.propertyName ?? element.name).text === name,
        ),
    );
  }

  function findEndpointHandler(
    endpointName: string,
  ):
    | { node: ts.Node; sourceFile: ts.SourceFile }
    | { createThreadMutation: true }
    | undefined {
    for (const sourceFile of sources) {
      let found:
        | { node: ts.Node; sourceFile: ts.SourceFile }
        | { createThreadMutation: true }
        | undefined;
      const visit = (node: ts.Node) => {
        if (found !== undefined) return;
        if (
          ts.isVariableDeclaration(node) &&
          ts.isIdentifier(node.name) &&
          node.name.text === endpointName &&
          node.initializer !== undefined &&
          isExportedDeclaration(node, sourceFile)
        ) {
          const initializer = unwrapNode(node.initializer);
          if (ts.isCallExpression(initializer)) {
            if (
              ts.isPropertyAccessExpression(initializer.expression) &&
              initializer.expression.name.text === "createThreadMutation" &&
              resolveInstance(
                initializer.expression.expression,
                sourceFile,
                initializer.pos,
              ) !== undefined
            ) {
              found = { createThreadMutation: true };
              return;
            }
            for (const argument of initializer.arguments) {
              const config = objectLiteralOf(argument);
              if (config === undefined) continue;
              for (const property of config.properties) {
                const isHandlerName =
                  property.name !== undefined &&
                  (ts.isIdentifier(property.name) ||
                    ts.isStringLiteral(property.name)) &&
                  property.name.text === "handler";
                if (ts.isPropertyAssignment(property) && isHandlerName) {
                  found = { node: property.initializer, sourceFile };
                }
                if (ts.isMethodDeclaration(property) && isHandlerName) {
                  found = { node: property.body ?? property, sourceFile };
                }
                if (
                  ts.isShorthandPropertyAssignment(property) &&
                  property.name.text === "handler"
                ) {
                  const body =
                    localFunctions.get("handler") ?? consts.get("handler");
                  if (body !== undefined) found = { node: body, sourceFile };
                }
              }
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  /** Does this generation call carry a tools override referencing a
   * defined tool (in any of its argument objects)? */
  function callOverridesTools(call: ts.CallExpression): boolean {
    for (const argument of call.arguments) {
      const objectLiteral = objectLiteralOf(argument);
      if (objectLiteral === undefined) continue;
      const toolsValue = findOptionValue(objectLiteral, "tools");
      if (toolsValue !== undefined && toolsConfigReferencesTool(toolsValue)) {
        return true;
      }
    }
    return false;
  }

  function walkPath(start: ts.Node, startFile: ts.SourceFile): PathFacts {
    const facts = emptyFacts();
    const walked = new Set<ts.Node>();

    const recordScoped = (ctor: AgentCtor, call: ts.CallExpression) => {
      facts.scopedGenerationInstances.set(ctor.key, ctor.name);
      if (callOverridesTools(call)) {
        facts.toolsOverrideAtGeneration = true;
      }
    };

    const visit = (node: ts.Node, file: ts.SourceFile, depth: number) => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression;

        // Standalone helpers, possibly renamed or namespace-imported.
        let helperName: string | undefined;
        if (ts.isIdentifier(callee)) {
          helperName = agentImports.get(callee.text);
        } else if (
          ts.isPropertyAccessExpression(callee) &&
          ts.isIdentifier(callee.expression) &&
          agentNamespaces.has(callee.expression.text)
        ) {
          helperName = callee.name.text;
        }
        if (helperName !== undefined) {
          const componentArg = node.arguments[1];
          const hasComponentArg =
            componentArg !== undefined && isComponentsRef(componentArg);
          if (hasComponentArg) {
            if (helperName === "createThread") facts.threadCreate = true;
            if (helperName === "saveMessage" || helperName === "saveMessages") {
              facts.componentSave = true;
            }
            if (
              helperName === "listMessages" ||
              helperName === "listUIMessages"
            ) {
              facts.componentList = true;
            }
          }
        }

        if (ts.isPropertyAccessExpression(callee)) {
          const method = callee.name.text;
          const instance = resolveInstance(callee.expression, file, node.pos);

          if (instance !== undefined) {
            if (
              method === "createThread" ||
              method === "createThreadMutation"
            ) {
              facts.threadCreate = true;
            }
            if (method === "saveMessage" || method === "saveMessages") {
              facts.componentSave = true;
            }
            if (method === "listMessages" || method === "listUIMessages") {
              facts.componentList = true;
            }
          }

          if (GENERATION_METHODS.has(method)) {
            // Direct scoped form: agent.generateText(ctx, { threadId }, ...)
            if (instance !== undefined) {
              const scopeArg = node.arguments[1];
              if (
                scopeArg !== undefined &&
                objectHasProp(scopeArg, "threadId")
              ) {
                recordScoped(instance, node);
              }
            } else {
              const receiver = unwrapNode(callee.expression);
              // Thread var bound from continueThread({ threadId }).
              if (ts.isIdentifier(receiver)) {
                const threadTarget = nearestBinding(
                  threadBindings,
                  receiver.text,
                  file,
                  node.pos,
                );
                if (threadTarget !== undefined) {
                  recordScoped(threadTarget, node);
                }
              }
              // Inline chain:
              // (await agent.continueThread(ctx, { threadId })).thread.generateText(...)
              if (
                ts.isPropertyAccessExpression(receiver) &&
                receiver.name.text === "thread"
              ) {
                const inner = unwrapNode(receiver.expression);
                if (ts.isCallExpression(inner)) {
                  const target = continueThreadTarget(inner, file);
                  if (target !== undefined) {
                    recordScoped(target, node);
                  }
                }
              }
            }
          }

          if (
            ["runQuery", "runMutation", "runAction"].includes(method) &&
            node.arguments[0] !== undefined &&
            isComponentsRef(node.arguments[0])
          ) {
            // Direct component calls: names may be slightly wrong in a
            // selection answer (stale/hallucinated API); classify by the
            // component module being addressed.
            const reference = node.arguments[0].getText();
            const readCall = method === "runQuery";
            if (
              reference.includes("createThread") ||
              (!readCall &&
                /\.threads\./.test(reference) &&
                /creat/i.test(reference))
            ) {
              facts.threadCreate = true;
            }
            if (
              reference.includes("addMessages") ||
              reference.includes("saveMessage") ||
              (!readCall && /\.messages\./.test(reference))
            ) {
              facts.componentSave = true;
            }
            if (
              reference.includes("listMessages") ||
              reference.includes("listUIMessages") ||
              (readCall && /\.messages\./.test(reference))
            ) {
              facts.componentList = true;
            }
          }
        }

        // Inline local helper functions (any authored module).
        if (
          ts.isIdentifier(callee) &&
          localFunctions.has(callee.text) &&
          depth < 4
        ) {
          const body = localFunctions.get(callee.text)!;
          if (!walked.has(body)) {
            walked.add(body);
            visit(body, body.getSourceFile(), depth + 1);
            walked.delete(body);
          }
        }
      }
      ts.forEachChild(node, (child) => visit(child, file, depth));
    };
    visit(start, startFile, 0);
    return facts;
  }

  const endpoints: Partial<Record<EndpointName, PathFacts>> = {};
  for (const endpoint of ENDPOINTS) {
    const handler = findEndpointHandler(endpoint);
    if (handler === undefined) continue;
    if ("createThreadMutation" in handler) {
      const facts = emptyFacts();
      facts.threadCreate = true;
      endpoints[endpoint] = facts;
    } else {
      endpoints[endpoint] = walkPath(handler.node, handler.sourceFile);
    }
  }

  // Built after the walks so inline constructions are included.
  const instancesWithTools = new Set<string>();
  let toolWiredInConstructor = false;
  for (const [key, ctor] of constructionsByKey) {
    if (ctor.options === undefined) continue;
    const toolsValue = findOptionValue(ctor.options, "tools");
    if (toolsValue !== undefined && toolsConfigReferencesTool(toolsValue)) {
      instancesWithTools.add(key);
      toolWiredInConstructor = true;
    }
  }

  return {
    dependsOnAgent,
    mountsAgent,
    agentNames: [...constructionsByKey.values()].map((ctor) => ctor.name),
    instancesWithTools,
    toolWiredInConstructor,
    messageStoreTables,
    endpoints,
  };
}

const analysis = analyze();

function pathFacts(endpoint: EndpointName): PathFacts {
  return analysis.endpoints[endpoint] ?? emptyFacts();
}

test("chooses the agent component as a dependency", () => {
  expect(analysis.dependsOnAgent).toBe(true);
});

test("mounts the component in the app config", () => {
  expect(analysis.mountsAgent).toBe(true);
});

test("wires a defined tool into the agent or its generation call", () => {
  expect(
    analysis.toolWiredInConstructor ||
      pathFacts("askAssistant").toolsOverrideAtGeneration,
    "define a lookup tool and wire it into an Agent `tools` config or a generation-call override - an unused tool definition is not enough",
  ).toBe(true);
});

test("openThread creates the durable thread in the component", () => {
  expect(
    pathFacts("openThread").threadCreate,
    "openThread must create the conversation as a component thread",
  ).toBe(true);
});

test("askAssistant generates against the durable thread with the tool-equipped agent", () => {
  const facts = pathFacts("askAssistant");
  const generating = generatingInstances(facts);
  expect(
    isThreadScopedGeneration(facts),
    "askAssistant must generate in the thread's context (thread-scoped generate/continueThread)",
  ).toBe(true);
  const toolEquipped =
    [...generating.keys()].some((key) =>
      analysis.instancesWithTools.has(key),
    ) || facts.toolsOverrideAtGeneration;
  expect(
    toolEquipped,
    "the agent generating in askAssistant must be the one carrying the tools",
  ).toBe(true);
});
