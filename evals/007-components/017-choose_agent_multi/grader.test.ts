import { expect, test } from "vitest";
import { getLatestOutputProjectDir } from "../../../grader/outputDir";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const CATEGORY = "007-components";
const EVAL_NAME = "017-choose_agent_multi";

// SELECTION eval, static pipeline (see eval.json): measures whether the
// model CHOSE the agent component for two specialized
// assistants handing off one shared durable conversation,
// tolerant of syntax, version, and API-shape noise. Correct wiring is
// graded by the usage eval (014). The TypeScript parser is
// error-recovering, so choices stay visible even in code that would not
// compile.

const ENDPOINTS = ["openConversation", "triage", "escalateToBilling", "getTranscript"] as const;

type EndpointName = (typeof ENDPOINTS)[number];

const GENERATION_METHODS = new Set([
  "generateText",
  "streamText",
  "generateObject",
  "streamObject",
]);

interface PathFacts {
  threadCreate: boolean;
  componentSave: boolean;
  componentList: boolean;
  /** instance key -> resolved constructor name, for thread-scoped generation */
  scopedGenerationInstances: Map<string, string | undefined>;
  /** instance key -> resolved constructor name, for continueThread({ threadId }) */
  continueThreadInstances: Map<string, string | undefined>;
  /** any generation-family method call (e.g. thread.generateText) */
  hasGenerationMethodCall: boolean;
  /** a generation-family call on this path overrides `tools` with a defined tool */
  toolsOverrideAtGeneration: boolean;
}

interface Analysis {
  dependsOnAgent: boolean;
  mountsAgent: boolean;
  /** resolved `name` constructor options across all Agent constructions */
  agentNames: (string | undefined)[];
  /** instance keys whose constructor wires a defined tool into `tools` */
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
    continueThreadInstances: new Map(),
    hasGenerationMethodCall: false,
    toolsOverrideAtGeneration: false,
  };
}

/** Thread-scoped generation: a scoped generate/stream call, or a
 * continueThread({ threadId }) whose thread is then generated against. */
function isThreadScopedGeneration(facts: PathFacts): boolean {
  return (
    facts.scopedGenerationInstances.size > 0 ||
    (facts.continueThreadInstances.size > 0 && facts.hasGenerationMethodCall)
  );
}

/** The agent instances a path generates against (either scoped form). */
function generatingInstances(facts: PathFacts): Map<string, string | undefined> {
  const instances = new Map(facts.scopedGenerationInstances);
  if (facts.hasGenerationMethodCall) {
    for (const [key, name] of facts.continueThreadInstances) {
      instances.set(key, name);
    }
  }
  return instances;
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

  let mountsAgent = false;

  // Global collections: models legitimately factor agents, tools, and
  // helpers into separate modules, so symbols are tracked across files.
  const agentImports = new Map<string, string>();
  const agentNamespaces = new Set<string>();
  const aiToolCtors = new Set<string>();
  const componentsAliases = new Set<string>(["components"]);
  const consts = new Map<string, ts.Expression>();
  const localFunctions = new Map<string, ts.Node>();
  const relativeImportAliases: Array<{ local: string; original: string }> = [];

  for (const sourceFile of sources) {
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
        mountsAgent = mountsAgent || /\.use\(/.test(sourceFile.getFullText());
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

  function objectHasProp(
    expression: ts.Expression,
    propName: string,
    depth = 0,
  ): boolean {
    const objectLiteral = objectLiteralOf(expression);
    if (objectLiteral === undefined) return false;
    for (const property of objectLiteral.properties) {
      if (
        ts.isShorthandPropertyAssignment(property) &&
        property.name.text === propName
      ) {
        return true;
      }
      if (
        (ts.isPropertyAssignment(property) ||
          ts.isMethodDeclaration(property)) &&
        property.name !== undefined &&
        (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
        property.name.text === propName
      ) {
        return true;
      }
      if (
        ts.isSpreadAssignment(property) &&
        depth < 2 &&
        objectHasProp(property.expression, propName, depth + 1)
      ) {
        return true;
      }
    }
    return false;
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

  function isAgentConstruction(
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

  // ── agent instances and tool definitions ───────────────────────────

  /** instance key (variable name or inline position) -> resolved `name` */
  const agentInstances = new Map<string, string | undefined>();
  const agentCtorOptions = new Map<string, ts.ObjectLiteralExpression>();
  const toolVars = new Set<string>();

  function ctorName(
    construction: ts.NewExpression,
  ): { name: string | undefined; options: ts.ObjectLiteralExpression | undefined } {
    const optionsArg = construction.arguments?.[1];
    const options =
      optionsArg === undefined ? undefined : objectLiteralOf(optionsArg);
    let name: string | undefined;
    if (options !== undefined) {
      for (const property of options.properties) {
        if (
          ts.isPropertyAssignment(property) &&
          (ts.isIdentifier(property.name) ||
            ts.isStringLiteral(property.name)) &&
          property.name.text === "name"
        ) {
          name = stringLiteralOf(property.initializer);
        }
      }
    }
    return { name, options };
  }

  for (const sourceFile of sources) {
    const collect = (node: ts.Node) => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer !== undefined
      ) {
        const construction = isAgentConstruction(node.initializer);
        if (construction !== undefined) {
          const { name, options } = ctorName(construction);
          agentInstances.set(node.name.text, name);
          if (options !== undefined) {
            agentCtorOptions.set(node.name.text, options);
          }
        }
        if (isToolish(node.initializer)) {
          toolVars.add(node.name.text);
        }
      }
      ts.forEachChild(node, collect);
    };
    collect(sourceFile);
  }

  // Propagate instances/tools through renamed relative imports (3 hops).
  for (let hop = 0; hop < 3; hop++) {
    for (const { local, original } of relativeImportAliases) {
      if (agentInstances.has(original) && !agentInstances.has(local)) {
        agentInstances.set(local, agentInstances.get(original));
        const options = agentCtorOptions.get(original);
        if (options !== undefined) agentCtorOptions.set(local, options);
      }
      if (toolVars.has(original)) toolVars.add(local);
    }
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

  function resolveInstance(
    expression: ts.Expression,
  ): { key: string; name: string | undefined } | undefined {
    const receiver = unwrapNode(expression);
    if (ts.isIdentifier(receiver) && agentInstances.has(receiver.text)) {
      return { key: receiver.text, name: agentInstances.get(receiver.text) };
    }
    const construction = isAgentConstruction(receiver);
    if (construction !== undefined) {
      const key = `inline@${construction.pos}`;
      if (!agentInstances.has(key)) {
        const { name, options } = ctorName(construction);
        agentInstances.set(key, name);
        if (options !== undefined) agentCtorOptions.set(key, options);
      }
      return { key, name: agentInstances.get(key) };
    }
    return undefined;
  }

  function findEndpointHandler(
    endpointName: string,
  ): { node: ts.Node } | { createThreadMutation: true } | undefined {
    for (const sourceFile of sources) {
      let found: { node: ts.Node } | { createThreadMutation: true } | undefined;
      const visit = (node: ts.Node) => {
        if (found !== undefined) return;
        if (
          ts.isVariableDeclaration(node) &&
          ts.isIdentifier(node.name) &&
          node.name.text === endpointName &&
          node.initializer !== undefined
        ) {
          const initializer = unwrapNode(node.initializer);
          if (ts.isCallExpression(initializer)) {
            if (
              ts.isPropertyAccessExpression(initializer.expression) &&
              initializer.expression.name.text === "createThreadMutation" &&
              resolveInstance(initializer.expression.expression) !== undefined
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
                  found = { node: property.initializer };
                }
                if (ts.isMethodDeclaration(property) && isHandlerName) {
                  found = { node: property.body ?? property };
                }
                if (
                  ts.isShorthandPropertyAssignment(property) &&
                  property.name.text === "handler"
                ) {
                  const body =
                    localFunctions.get("handler") ?? consts.get("handler");
                  if (body !== undefined) found = { node: body };
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

  function walkPath(start: ts.Node): PathFacts {
    const facts = emptyFacts();
    const walked = new Set<ts.Node>();

    const visit = (node: ts.Node, depth: number) => {
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
          const instance = resolveInstance(callee.expression);

          if (instance !== undefined) {
            if (method === "createThread" || method === "createThreadMutation") {
              facts.threadCreate = true;
            }
            if (method === "saveMessage" || method === "saveMessages") {
              facts.componentSave = true;
            }
            if (method === "listMessages" || method === "listUIMessages") {
              facts.componentList = true;
            }
            if (
              method === "continueThread" &&
              node.arguments.some((argument) =>
                objectHasProp(argument, "threadId"),
              )
            ) {
              facts.continueThreadInstances.set(instance.key, instance.name);
            }
          }

          if (GENERATION_METHODS.has(method)) {
            facts.hasGenerationMethodCall = true;
            for (const argument of node.arguments) {
              const objectLiteral = objectLiteralOf(argument);
              if (objectLiteral === undefined) continue;
              for (const property of objectLiteral.properties) {
                if (
                  ts.isPropertyAssignment(property) &&
                  (ts.isIdentifier(property.name) ||
                    ts.isStringLiteral(property.name)) &&
                  property.name.text === "tools" &&
                  toolsConfigReferencesTool(property.initializer)
                ) {
                  facts.toolsOverrideAtGeneration = true;
                }
              }
            }
            if (instance !== undefined) {
              const scopeArg = node.arguments[1];
              if (
                scopeArg !== undefined &&
                objectHasProp(scopeArg, "threadId")
              ) {
                facts.scopedGenerationInstances.set(
                  instance.key,
                  instance.name,
                );
              }
            }
          }

          if (
            ["runQuery", "runMutation", "runAction"].includes(method) &&
            node.arguments[0] !== undefined &&
            isComponentsRef(node.arguments[0])
          ) {
            const reference = node.arguments[0].getText();
            if (reference.includes("createThread")) facts.threadCreate = true;
            if (
              reference.includes("addMessages") ||
              reference.includes("saveMessage")
            ) {
              facts.componentSave = true;
            }
            if (
              reference.includes("listMessages") ||
              reference.includes("listUIMessages")
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
            visit(body, depth + 1);
            walked.delete(body);
          }
        }
      }
      ts.forEachChild(node, (child) => visit(child, depth));
    };
    visit(start, 0);
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
      endpoints[endpoint] = walkPath(handler.node);
    }
  }

  // Built after the walks so inline constructions are included.
  const instancesWithTools = new Set<string>();
  let toolWiredInConstructor = false;
  for (const [key, options] of agentCtorOptions) {
    for (const property of options.properties) {
      if (
        ts.isPropertyAssignment(property) &&
        (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
        property.name.text === "tools" &&
        toolsConfigReferencesTool(property.initializer)
      ) {
        instancesWithTools.add(key);
        toolWiredInConstructor = true;
      }
    }
  }

  return {
    dependsOnAgent,
    mountsAgent,
    agentNames: [...agentInstances.values()],
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

test("defines two distinctly named specialist agents", () => {
  const resolvedNames = analysis.agentNames.filter(
    (name): name is string => name !== undefined,
  );
  expect(
    new Set(resolvedNames).size,
    `define two Agent instances whose \`name\` options are distinct string values (saw: ${JSON.stringify(resolvedNames)})`,
  ).toBeGreaterThanOrEqual(2);
});

test("triage replies inside the shared conversation", () => {
  expect(
    isThreadScopedGeneration(pathFacts("triage")),
    "triage must generate in the conversation's thread (thread-scoped generate/continueThread)",
  ).toBe(true);
});

test("escalateToBilling continues the same conversation", () => {
  expect(
    isThreadScopedGeneration(pathFacts("escalateToBilling")),
    "escalateToBilling must generate in the SAME thread (thread-scoped generate/continueThread)",
  ).toBe(true);
});

test("the handoff switches to a differently-named agent", () => {
  const triageInstances = generatingInstances(pathFacts("triage"));
  const billingInstances = generatingInstances(pathFacts("escalateToBilling"));
  const distinct = [...triageInstances].some(([triageKey, triageName]) =>
    [...billingInstances].some(
      ([billingKey, billingName]) =>
        (triageName ?? triageKey) !== (billingName ?? billingKey),
    ),
  );
  expect(
    distinct,
    "triage and escalateToBilling must generate with two different agents on the one thread",
  ).toBe(true);
});

test("getTranscript reads the shared history from the component", () => {
  expect(
    pathFacts("getTranscript").componentList,
    "getTranscript must list the thread's messages from the component",
  ).toBe(true);
});
