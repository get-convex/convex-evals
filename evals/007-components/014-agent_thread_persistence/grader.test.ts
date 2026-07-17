import { expect, test } from "vitest";
import {
  compareFunctionSpec,
  compareSchema,
  getLatestOutputProjectDir,
  readOutputFile,
  responseClient,
} from "../../../grader";
import { anyApi } from "convex/server";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const CATEGORY = "007-components";
const EVAL_NAME = "014-agent_thread_persistence";

test("compare schema", async ({ skip }) => {
  await compareSchema(skip);
});

test("compare function spec", async ({ skip }) => {
  await compareFunctionSpec(skip, { ignoreReturns: true, publicOnly: true });
});

type Exchange = { role: string; content: string };

const THREAD_A_MESSAGES: Exchange[] = [
  { role: "user", content: "m1" },
  { role: "assistant", content: "m2" },
  { role: "user", content: "m3" },
  { role: "assistant", content: "m4" },
  { role: "user", content: "m5" },
];

// One ordered flow: thread state lives inside the component and cannot be
// reset through root tables, so create/save/list/isolation run in sequence.
test(
  "threads persist alternating messages, paginate oldest-first, and stay isolated",
  { timeout: 30_000 },
  async () => {
    const getPage = (threadId: string, numItems: number, cursor: string | null) =>
      responseClient.query(anyApi.index.getConversation, {
        threadId,
        paginationOpts: { numItems, cursor },
      });

    const threadA = await responseClient.mutation(
      anyApi.index.createConversation,
      { userId: "user-a", title: "Trip planning" },
    );
    expect(threadA, "createConversation must return the thread id").toBeTypeOf(
      "string",
    );
    expect(threadA.length).toBeGreaterThan(0);

    // A brand-new conversation has an empty, already-done first page.
    const empty = await getPage(threadA, 5, null);
    expect(empty.page).toEqual([]);
    expect(empty.isDone).toBe(true);

    for (const { role, content } of THREAD_A_MESSAGES) {
      const post =
        role === "user"
          ? anyApi.index.postUserMessage
          : anyApi.index.postAssistantMessage;
      await responseClient.mutation(post, { threadId: threadA, text: content });
    }

    // A second user's thread, created and populated after thread A.
    const threadB = await responseClient.mutation(
      anyApi.index.createConversation,
      { userId: "user-b", title: "Other topic" },
    );
    expect(threadB).toBeTypeOf("string");
    expect(threadB, "each conversation must get its own thread").not.toBe(
      threadA,
    );
    await responseClient.mutation(anyApi.index.postUserMessage, {
      threadId: threadB,
      text: "other-1",
    });
    await responseClient.mutation(anyApi.index.postAssistantMessage, {
      threadId: threadB,
      text: "other-2",
    });

    // Full history in one page: exact roles and texts, oldest first, and
    // page items carry role/content only.
    const fullA = await getPage(threadA, 20, null);
    expect(fullA.isDone).toBe(true);
    expect(
      fullA.page,
      "getConversation must return thread A's messages oldest-first as { role, content }",
    ).toEqual(THREAD_A_MESSAGES);
    expect(fullA.continueCursor).toBeTypeOf("string");

    // Cursor pagination walks backward from the most recent messages while
    // each page stays oldest-first. numItems: 2 over five messages must
    // yield [m4, m5], then [m2, m3], then [m1].
    const pages: Exchange[][] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 10; i++) {
      const result = await getPage(threadA, 2, cursor);
      expect(Array.isArray(result.page)).toBe(true);
      pages.push(result.page);
      if (result.isDone) break;
      expect(result.continueCursor).toBeTypeOf("string");
      cursor = result.continueCursor;
    }
    expect(
      pages[pages.length - 1],
      "pagination must terminate with isDone: true",
    ).toBeDefined();
    expect(
      pages[0],
      "the first page (cursor: null) must hold the two MOST RECENT messages, oldest-first",
    ).toEqual(THREAD_A_MESSAGES.slice(3));
    const reassembled = pages.slice().reverse().flat();
    expect(
      reassembled,
      "following continueCursor must walk back through the full history",
    ).toEqual(THREAD_A_MESSAGES);

    // Thread isolation: B sees exactly its own messages, in order.
    const fullB = await getPage(threadB, 20, null);
    expect(fullB.isDone).toBe(true);
    expect(fullB.page).toEqual([
      { role: "user", content: "other-1" },
      { role: "assistant", content: "other-2" },
    ]);
  },
);

test("generated solution pins the component and its peers, and mounts it", () => {
  const packageJson = JSON.parse(
    readOutputFile(CATEGORY, EVAL_NAME, "package.json"),
  );
  expect(packageJson.dependencies["convex"]).toBe("1.41.0");
  expect(packageJson.dependencies["@convex-dev/agent"]).toBe("0.6.4");
  expect(packageJson.dependencies["ai"]).toBe("6.0.229");
  expect(packageJson.dependencies["@ai-sdk/provider-utils"]).toBe("4.0.39");
  expect(packageJson.dependencies["convex-helpers"]).toBe("0.1.120");

  const config = readOutputFile(CATEGORY, EVAL_NAME, "convex/convex.config.ts");
  expect(
    hasAgentMount(config),
    "convex.config.ts must app.use() the agent component's convex.config",
  ).toBe(true);
});

test("generated solution stores messages in the component, not app tables", () => {
  const analysis = analyzeAuthoredConvexSources();

  expect(
    analysis.messageStoreTables,
    `the app schema must not hand-roll a message store: ${analysis.messageStoreTables.join(", ")}`,
  ).toEqual([]);

  expect(
    analysis.reachedOperations.createConversation.has("threadCreate"),
    "createConversation must create the thread in the agent component",
  ).toBe(true);
  expect(
    analysis.reachedOperations.postUserMessage.has("messageSave"),
    "postUserMessage must save through the agent component",
  ).toBe(true);
  expect(
    analysis.reachedOperations.postAssistantMessage.has("messageSave"),
    "postAssistantMessage must save through the agent component",
  ).toBe(true);
  expect(
    analysis.reachedOperations.getConversation.has("messageList"),
    "getConversation must list messages from the agent component",
  ).toBe(true);
});

// ── convex.config.ts mount check ─────────────────────────────────────

function hasAgentMount(sourceText: string): boolean {
  const sourceFile = ts.createSourceFile(
    "convex.config.ts",
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const agentImports = new Set<string>();
  const agentNamespaces = new Set<string>();
  const declarations = collectConstDeclarations(sourceFile);

  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !/^@convex-dev\/agent\/convex\.config(?:\.js)?$/.test(
        statement.moduleSpecifier.text,
      )
    ) {
      continue;
    }
    const defaultImport = statement.importClause?.name;
    if (defaultImport !== undefined) agentImports.add(defaultImport.text);
    const bindings = statement.importClause?.namedBindings;
    if (bindings !== undefined && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        if ((element.propertyName ?? element.name).text === "default") {
          agentImports.add(element.name.text);
        }
      }
    } else if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
      agentNamespaces.add(bindings.name.text);
    }
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
      if (
        (ts.isIdentifier(component) && agentImports.has(component.text)) ||
        (ts.isPropertyAccessExpression(component) &&
          component.name.text === "default" &&
          ts.isIdentifier(component.expression) &&
          agentNamespaces.has(component.expression.text))
      ) {
        mounted = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return mounted;
}

// ── call-path analysis ───────────────────────────────────────────────

type Operation = "threadCreate" | "messageSave" | "messageList";

const ENDPOINTS = [
  "createConversation",
  "postUserMessage",
  "postAssistantMessage",
  "getConversation",
] as const;

type EndpointName = (typeof ENDPOINTS)[number];

interface ModuleInfo {
  sourceFile: ts.SourceFile;
  /** local name -> original name, for named imports from @convex-dev/agent */
  agentImports: Map<string, string>;
  /** namespace names for `import * as ns from "@convex-dev/agent"` */
  agentNamespaces: Set<string>;
  /** local name -> { module, originalName } for relative imports */
  localImports: Map<string, { module: string; originalName: string }>;
  /** namespace name -> module for relative namespace imports */
  localNamespaceImports: Map<string, string>;
  /** const name -> initializer */
  consts: Map<string, ts.Expression>;
  /** function name -> body (declarations and arrow/function consts) */
  functions: Map<string, ts.Node>;
  /** names of variables holding `new Agent(components.agent, ...)` */
  agentInstances: Set<string>;
}

interface Analysis {
  messageStoreTables: string[];
  reachedOperations: Record<EndpointName, Set<Operation>>;
}

const HELPER_TO_OPERATION: Record<string, Operation> = {
  createThread: "threadCreate",
  saveMessage: "messageSave",
  saveMessages: "messageSave",
  listMessages: "messageList",
  listUIMessages: "messageList",
};

function analyzeAuthoredConvexSources(): Analysis {
  const modules = loadAuthoredModules();

  // Pass 1: per-module symbol tables.
  const infos = new Map<string, ModuleInfo>();
  for (const [moduleName, sourceFile] of modules) {
    infos.set(moduleName, buildModuleInfo(moduleName, sourceFile, modules));
  }

  // Agent instances imported from other authored modules also count as
  // instances locally.
  for (const info of infos.values()) {
    for (const [localName, target] of info.localImports) {
      const targetInfo = infos.get(target.module);
      if (targetInfo?.agentInstances.has(target.originalName) === true) {
        info.agentInstances.add(localName);
      }
    }
  }

  const messageStoreTables: string[] = [];
  for (const [moduleName, info] of infos) {
    collectMessageStoreTables(moduleName, info.sourceFile, messageStoreTables);
  }

  const reachedOperations = Object.fromEntries(
    ENDPOINTS.map((endpoint) => [endpoint, new Set<Operation>()]),
  ) as Record<EndpointName, Set<Operation>>;

  const indexInfo = infos.get("index");
  if (indexInfo !== undefined) {
    for (const endpoint of ENDPOINTS) {
      const handler = findRegisteredHandler(indexInfo, endpoint);
      if (handler === undefined) continue;
      walkCallPath(
        handler,
        "index",
        infos,
        reachedOperations[endpoint],
        new Set(),
        0,
      );
    }
  }

  return { messageStoreTables, reachedOperations };
}

function loadAuthoredModules(): Map<string, ts.SourceFile> {
  const projectDir = getLatestOutputProjectDir(CATEGORY, EVAL_NAME);
  const modules = new Map<string, ts.SourceFile>();
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
      modules.set(
        relativePath.replace(/\.ts$/, ""),
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
  return modules;
}

function buildModuleInfo(
  moduleName: string,
  sourceFile: ts.SourceFile,
  modules: Map<string, ts.SourceFile>,
): ModuleInfo {
  const info: ModuleInfo = {
    sourceFile,
    agentImports: new Map(),
    agentNamespaces: new Set(),
    localImports: new Map(),
    localNamespaceImports: new Map(),
    consts: collectConstDeclarations(sourceFile),
    functions: new Map(),
    agentInstances: new Set(),
  };

  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      continue;
    }
    const spec = statement.moduleSpecifier.text;
    const bindings = statement.importClause?.namedBindings;
    if (spec === "@convex-dev/agent") {
      if (bindings !== undefined && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          info.agentImports.set(
            element.name.text,
            (element.propertyName ?? element.name).text,
          );
        }
      } else if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
        info.agentNamespaces.add(bindings.name.text);
      }
    } else if (spec.startsWith(".")) {
      const target = resolveRelativeModule(moduleName, spec, modules);
      if (target === undefined) continue;
      if (bindings !== undefined && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          info.localImports.set(element.name.text, {
            module: target,
            originalName: (element.propertyName ?? element.name).text,
          });
        }
      } else if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
        info.localNamespaceImports.set(bindings.name.text, target);
      }
    }
  }

  const collect = (node: ts.Node) => {
    if (
      ts.isFunctionDeclaration(node) &&
      node.name !== undefined &&
      node.body !== undefined
    ) {
      info.functions.set(node.name.text, node.body);
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined
    ) {
      const initializer = unwrap(node.initializer);
      if (
        ts.isArrowFunction(initializer) ||
        ts.isFunctionExpression(initializer)
      ) {
        info.functions.set(node.name.text, initializer.body);
      }
      if (isAgentConstruction(initializer, info)) {
        info.agentInstances.add(node.name.text);
      }
    }
    ts.forEachChild(node, collect);
  };
  collect(sourceFile);

  return info;
}

function resolveRelativeModule(
  importerModule: string,
  specifier: string,
  modules: Map<string, ts.SourceFile>,
): string | undefined {
  const importerDir = importerModule.includes("/")
    ? importerModule.slice(0, importerModule.lastIndexOf("/"))
    : "";
  const raw = specifier.replace(/\.(ts|js)$/, "");
  const segments = (importerDir === "" ? [] : importerDir.split("/")).concat(
    raw.split("/"),
  );
  const resolved: string[] = [];
  for (const segment of segments) {
    if (segment === "." || segment === "") continue;
    if (segment === "..") resolved.pop();
    else resolved.push(segment);
  }
  const candidate = resolved.join("/");
  if (modules.has(candidate)) return candidate;
  if (modules.has(`${candidate}/index`)) return `${candidate}/index`;
  return undefined;
}

function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
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
    current = unwrap(current);
    if (
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
  return unwrap(current);
}

/** Does the expression resolve to `components.agent` (aliases allowed)? */
function isComponentsAgent(expression: ts.Expression, info: ModuleInfo): boolean {
  const resolved = resolveExpression(expression, info.consts);
  return (
    ts.isPropertyAccessExpression(resolved) &&
    resolved.name.text === "agent" &&
    ts.isIdentifier(unwrap(resolved.expression)) &&
    (unwrap(resolved.expression) as ts.Identifier).text === "components"
  );
}

function isAgentConstruction(
  expression: ts.Expression,
  info: ModuleInfo,
): boolean {
  if (!ts.isNewExpression(expression)) return false;
  const callee = expression.expression;
  const isAgentCtor =
    (ts.isIdentifier(callee) && info.agentImports.get(callee.text) === "Agent") ||
    (ts.isPropertyAccessExpression(callee) &&
      callee.name.text === "Agent" &&
      ts.isIdentifier(callee.expression) &&
      info.agentNamespaces.has(callee.expression.text));
  if (!isAgentCtor) return false;
  const firstArg = expression.arguments?.[0];
  return firstArg !== undefined && isComponentsAgent(firstArg, info);
}

function collectMessageStoreTables(
  moduleName: string,
  sourceFile: ts.SourceFile,
  found: string[],
): void {
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
          (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
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
        found.push(`${moduleName}: defineTable({ ${[...fields].join(", ")} })`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

function findRegisteredHandler(
  info: ModuleInfo,
  endpointName: string,
): ts.Node | undefined {
  let handler: ts.Node | undefined;
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === endpointName &&
      node.initializer !== undefined
    ) {
      const initializer = unwrap(node.initializer);
      if (
        ts.isCallExpression(initializer) &&
        initializer.arguments.length >= 1
      ) {
        const config = resolveExpression(initializer.arguments[0], info.consts);
        if (ts.isObjectLiteralExpression(config)) {
          for (const property of config.properties) {
            const isHandler =
              property.name !== undefined &&
              (ts.isIdentifier(property.name) ||
                ts.isStringLiteral(property.name)) &&
              property.name.text === "handler";
            if (ts.isPropertyAssignment(property) && isHandler) {
              handler = property.initializer;
            }
            if (ts.isMethodDeclaration(property) && isHandler) {
              handler = property.body;
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(info.sourceFile);
  return handler;
}

/**
 * Walk a handler's call graph (inlining helpers, following authored-module
 * imports) and record which component operations it reaches:
 *  - standalone helpers with a `components.agent` argument
 *  - Agent-instance methods (instances constructed on `components.agent`)
 *  - direct ctx.runQuery/runMutation/runAction on `components.agent.*`
 */
function walkCallPath(
  node: ts.Node,
  moduleName: string,
  infos: Map<string, ModuleInfo>,
  reached: Set<Operation>,
  walked: Set<ts.Node>,
  depth: number,
): void {
  const info = infos.get(moduleName)!;

  const visit = (current: ts.Node) => {
    if (ts.isCallExpression(current)) {
      classifyCall(current, info, reached);
      followHelper(current, moduleName, infos, reached, walked, depth);
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
}

function classifyCall(
  call: ts.CallExpression,
  info: ModuleInfo,
  reached: Set<Operation>,
): void {
  const callee = call.expression;

  // Standalone helper: createThread(ctx, components.agent, ...) - possibly
  // renamed on import, possibly through a namespace.
  let originalName: string | undefined;
  if (ts.isIdentifier(callee)) {
    originalName = info.agentImports.get(callee.text);
  } else if (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    info.agentNamespaces.has(callee.expression.text)
  ) {
    originalName = callee.name.text;
  }
  if (originalName !== undefined) {
    const operation = HELPER_TO_OPERATION[originalName];
    if (
      operation !== undefined &&
      call.arguments[1] !== undefined &&
      isComponentsAgent(call.arguments[1], info)
    ) {
      reached.add(operation);
    }
  }

  if (ts.isPropertyAccessExpression(callee)) {
    const method = callee.name.text;
    const operation = HELPER_TO_OPERATION[method];

    // Agent-instance method: instance vars are constructed on
    // components.agent; also accept an inline `new Agent(...)` receiver.
    if (operation !== undefined) {
      const receiver = resolveExpression(callee.expression, info.consts);
      const receiverIsInstance =
        (ts.isIdentifier(unwrap(callee.expression)) &&
          info.agentInstances.has(
            (unwrap(callee.expression) as ts.Identifier).text,
          )) ||
        isAgentConstruction(receiver, info);
      if (receiverIsInstance) {
        reached.add(operation);
      }
    }

    // Direct component calls: invocation style is an API detail; delegation
    // to the component is what this eval requires.
    if (
      ["runQuery", "runMutation", "runAction"].includes(method) &&
      call.arguments[0] !== undefined
    ) {
      const reference = call.arguments[0].getText();
      if (reference.startsWith("components.agent.")) {
        if (reference.includes("createThread")) reached.add("threadCreate");
        if (
          reference.includes("addMessages") ||
          reference.includes("saveMessage")
        ) {
          reached.add("messageSave");
        }
        if (reference.includes("listMessages")) reached.add("messageList");
      }
    }
  }
}

function followHelper(
  call: ts.CallExpression,
  moduleName: string,
  infos: Map<string, ModuleInfo>,
  reached: Set<Operation>,
  walked: Set<ts.Node>,
  depth: number,
): void {
  if (depth >= 4) return;
  const info = infos.get(moduleName)!;
  const callee = call.expression;

  let body: ts.Node | undefined;
  let bodyModule = moduleName;

  if (ts.isIdentifier(callee)) {
    body = info.functions.get(callee.text);
    if (body === undefined) {
      const imported = info.localImports.get(callee.text);
      if (imported !== undefined) {
        body = infos.get(imported.module)?.functions.get(imported.originalName);
        bodyModule = imported.module;
      }
    }
  } else if (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression)
  ) {
    const namespaceModule = info.localNamespaceImports.get(
      callee.expression.text,
    );
    if (namespaceModule !== undefined) {
      body = infos.get(namespaceModule)?.functions.get(callee.name.text);
      bodyModule = namespaceModule;
    }
  }

  if (body !== undefined && !walked.has(body)) {
    walked.add(body);
    walkCallPath(body, bodyModule, infos, reached, walked, depth + 1);
    walked.delete(body);
  }
}
