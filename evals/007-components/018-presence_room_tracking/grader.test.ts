import { expect, test } from "vitest";
import {
  compareFunctionSpec,
  pollUntil,
  readOutputFile,
  responseClient,
  getLatestOutputProjectDir,
} from "../../../grader";
import { anyApi } from "convex/server";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import ts from "typescript";

const CATEGORY = "007-components";
const EVAL_NAME = "018-presence_room_tracking";

test("compare function spec", async ({ skip }) => {
  // The task dictates the public surface; return validators are optional and
  // internal helpers (if any) are the model's business.
  await compareFunctionSpec(skip, { ignoreReturns: true, publicOnly: true });
});

// ── Behavioral tests ──────────────────────────────────────────────────
//
// All presence assertions target the `online` flag: in 0.3.2 offline users
// REMAIN in `list` results with `online: false`; rows are never removed by
// disconnects or timeouts.

type PresenceEntry = {
  userId: string;
  online: boolean;
  lastDisconnected: number;
  data?: unknown;
};

type HeartbeatTokens = { roomToken: string; sessionToken: string };

// A 60s interval times out at 150s (2.5x), far beyond this grader's
// lifetime, so long-interval sessions only ever transition via explicit
// disconnect - keeping every non-timeout assertion deterministic.
const LONG_INTERVAL = 60_000;
// The dedicated timeout test uses 2s, so its session goes offline at ~5s.
const SHORT_INTERVAL = 2_000;

const heartbeat = (
  roomId: string,
  userId: string,
  sessionId: string,
  interval: number,
): Promise<HeartbeatTokens> =>
  responseClient.mutation(anyApi.index.heartbeat, {
    roomId,
    userId,
    sessionId,
    interval,
  });
const listRoom = (roomToken: string): Promise<PresenceEntry[]> =>
  responseClient.query(anyApi.index.list, { roomToken });
const disconnect = (sessionToken: string): Promise<unknown> =>
  responseClient.mutation(anyApi.index.disconnect, { sessionToken });
const entriesFor = (entries: PresenceEntry[], userId: string) =>
  entries.filter((entry) => entry.userId === userId);

/**
 * Wait until at least `sinceMs` have elapsed after `startedAt`. Not a fixed
 * sleep for scheduled work (pollUntil covers those): it guarantees a window
 * has passed before asserting that a timeout did NOT fire.
 */
async function waitUntilElapsed(
  startedAt: number,
  sinceMs: number,
): Promise<void> {
  const remaining = startedAt + sinceMs - Date.now();
  if (remaining > 0) {
    await new Promise((resolve) => setTimeout(resolve, remaining));
  }
}

let roomAToken: string;
let roomBToken: string;
let aliceSessionToken: string;
let longIntervalHeartbeatAt = 0;

test(
  "room isolation: each room lists exactly its own online users",
  { timeout: 30_000 },
  async () => {
    longIntervalHeartbeatAt = Date.now();
    const alice = await heartbeat(
      "room-A",
      "alice",
      "alice-tab-1",
      LONG_INTERVAL,
    );
    expect(typeof alice.roomToken, "heartbeat must return a roomToken").toBe(
      "string",
    );
    expect(
      typeof alice.sessionToken,
      "heartbeat must return a sessionToken",
    ).toBe("string");
    const bob = await heartbeat("room-A", "bob", "bob-tab-1", LONG_INTERVAL);
    const carol = await heartbeat(
      "room-B",
      "carol",
      "carol-tab-1",
      LONG_INTERVAL,
    );
    roomAToken = alice.roomToken;
    roomBToken = carol.roomToken;
    aliceSessionToken = alice.sessionToken;

    const inRoomA = await listRoom(roomAToken);
    expect(
      inRoomA
        .filter((entry) => entry.online)
        .map((entry) => entry.userId)
        .sort(),
      "room A must list exactly its own users as online",
    ).toEqual(["alice", "bob"]);
    expect(
      entriesFor(inRoomA, "carol"),
      "room B's user must not appear in room A",
    ).toHaveLength(0);

    const inRoomB = await listRoom(roomBToken);
    expect(
      inRoomB
        .filter((entry) => entry.online)
        .map((entry) => entry.userId)
        .sort(),
      "room B must list exactly its own user as online",
    ).toEqual(["carol"]);
    expect(entriesFor(inRoomB, "alice")).toHaveLength(0);
    expect(entriesFor(inRoomB, "bob")).toHaveLength(0);
  },
);

test(
  "graceful disconnect flips that user to online:false without removing the entry",
  { timeout: 30_000 },
  async () => {
    await disconnect(aliceSessionToken);
    await pollUntil(
      async () => {
        const entries = await listRoom(roomAToken);
        return entries.some(
          (entry) => entry.userId === "alice" && entry.online === false,
        );
      },
      { timeoutMs: 10_000, intervalMs: 250 },
    );

    const inRoomA = await listRoom(roomAToken);
    const alice = entriesFor(inRoomA, "alice");
    expect(
      alice,
      "a disconnected user must remain listed (as one entry) with online:false",
    ).toHaveLength(1);
    expect(alice[0].online).toBe(false);
    expect(
      alice[0].lastDisconnected,
      "a disconnected user's lastDisconnected must be set",
    ).toBeGreaterThan(0);
    const bob = entriesFor(inRoomA, "bob");
    expect(bob, "the other user must be unaffected").toHaveLength(1);
    expect(bob[0].online).toBe(true);

    const inRoomB = await listRoom(roomBToken);
    expect(entriesFor(inRoomB, "carol")[0].online).toBe(true);
  },
);

test(
  "multi-session: one aggregated entry per user, online while any session lives",
  { timeout: 30_000 },
  async () => {
    const tab1 = await heartbeat("room-C", "dave", "dave-tab-1", LONG_INTERVAL);
    const tab2 = await heartbeat("room-C", "dave", "dave-tab-2", LONG_INTERVAL);
    expect(
      tab2.sessionToken,
      "each session must get its own sessionToken",
    ).not.toBe(tab1.sessionToken);

    let entries = await listRoom(tab1.roomToken);
    let dave = entriesFor(entries, "dave");
    expect(
      dave,
      "a user with two sessions must appear as ONE entry, not one per session",
    ).toHaveLength(1);
    expect(dave[0].online).toBe(true);

    await disconnect(tab1.sessionToken);
    entries = await listRoom(tab1.roomToken);
    dave = entriesFor(entries, "dave");
    expect(dave).toHaveLength(1);
    expect(
      dave[0].online,
      "the user must stay online while their other session is still alive",
    ).toBe(true);

    await disconnect(tab2.sessionToken);
    await pollUntil(
      async () => {
        const current = await listRoom(tab1.roomToken);
        return current.some(
          (entry) => entry.userId === "dave" && entry.online === false,
        );
      },
      { timeoutMs: 10_000, intervalMs: 250 },
    );
    entries = await listRoom(tab1.roomToken);
    dave = entriesFor(entries, "dave");
    expect(dave, "still one aggregated entry after going offline").toHaveLength(
      1,
    );
    expect(
      dave[0].online,
      "disconnecting the LAST session must flip the user offline",
    ).toBe(false);
  },
);

test(
  "timeout: a session that stops heartbeating goes offline at ~2.5x its interval",
  { timeout: 30_000 },
  async () => {
    // Dedicated session in a dedicated room; never reused by other tests.
    const eve = await heartbeat(
      "room-D",
      "eve",
      "eve-timeout-tab",
      SHORT_INTERVAL,
    );
    const immediately = await listRoom(eve.roomToken);
    const eveNow = entriesFor(immediately, "eve");
    expect(eveNow).toHaveLength(1);
    expect(
      eveNow[0].online,
      "a freshly heartbeating session must be online immediately",
    ).toBe(true);

    // No further heartbeats: the component's scheduled timeout must mark the
    // entry offline at ~5s (2.5x the 2000ms interval). The 15s budget cleanly
    // separates a passed-through interval from implementations that drop the
    // caller's interval (component default 10s -> timeout at 25s).
    await pollUntil(
      async () => {
        const entries = await listRoom(eve.roomToken);
        return entries.some(
          (entry) => entry.userId === "eve" && entry.online === false,
        );
      },
      { timeoutMs: 15_000, intervalMs: 250 },
    );

    const after = await listRoom(eve.roomToken);
    const eveAfter = entriesFor(after, "eve");
    expect(
      eveAfter,
      "a timed-out user must remain listed with online:false",
    ).toHaveLength(1);
    expect(eveAfter[0].online).toBe(false);
  },
);

test(
  "interval pass-through: long-interval sessions must not time out early",
  { timeout: 30_000 },
  async () => {
    // bob and carol heartbeated ONCE with a 60s interval when this grader
    // started; their timeout would fire at 150s. An implementation that
    // ignores the caller's interval and hardcodes something near the timeout
    // test's 2s would have flipped them offline at ~5s - well before this
    // 9s-elapsed checkpoint.
    await waitUntilElapsed(longIntervalHeartbeatAt, 9_000);
    const inRoomA = await listRoom(roomAToken);
    expect(
      entriesFor(inRoomA, "bob")[0].online,
      "bob heartbeated with a 60s interval and must still be online",
    ).toBe(true);
    const inRoomB = await listRoom(roomBToken);
    expect(
      entriesFor(inRoomB, "carol")[0].online,
      "carol heartbeated with a 60s interval and must still be online",
    ).toBe(true);
  },
);

// ── Static checks ─────────────────────────────────────────────────────

test("generated solution pins and mounts the presence component", () => {
  const packageJson = JSON.parse(
    readOutputFile(CATEGORY, EVAL_NAME, "package.json"),
  ) as { dependencies?: Record<string, string> };
  expect(packageJson.dependencies?.["@convex-dev/presence"]).toBe("0.3.2");
  expect(packageJson.dependencies?.["convex"]).toBe("1.41.0");

  const config = readOutputFile(CATEGORY, EVAL_NAME, "convex/convex.config.ts");
  expect(
    hasPresenceMount(config),
    "convex.config.ts must mount @convex-dev/presence/convex.config",
  ).toBe(true);
});

test("every endpoint delegates to the presence component on its call path", () => {
  const analysis = analyzeAuthoredConvexSources();
  expect(
    analysis.constructsPresenceClient,
    "construct the client: new Presence(components.presence)",
  ).toBe(true);
  expect(
    analysis.endpointComponentCalls.heartbeat.has("heartbeat"),
    "the heartbeat mutation must reach the component's heartbeat on its call path",
  ).toBe(true);
  expect(
    analysis.endpointComponentCalls.list.has("list"),
    "the list query must reach the component's list on its call path",
  ).toBe(true);
  expect(
    analysis.endpointComponentCalls.disconnect.has("disconnect"),
    "the disconnect mutation must reach the component's disconnect on its call path",
  ).toBe(true);
});

// ── Static analysis machinery ─────────────────────────────────────────
//
// Purely syntactic (no TypeChecker), but call-path-connected: endpoint
// handler -> local/imported helpers (depth-limited) -> presence-instance
// method or direct components.* run-call. Tolerates renamed imports,
// namespace imports, const aliases, and instances/helpers factored into
// other authored modules.

const ENDPOINT_NAMES = ["heartbeat", "list", "disconnect"] as const;
type EndpointName = (typeof ENDPOINT_NAMES)[number];

interface SourceModule {
  path: string; // normalized, relative to the project dir (e.g. convex/index.ts)
  sourceFile: ts.SourceFile;
  declarations: Map<string, ts.Expression>;
  presenceCtorNames: Set<string>;
  presenceNamespaces: Set<string>; // namespace imports of @convex-dev/presence
  componentsBindings: Set<string>; // local names of `components` from ./_generated/api
  namedImports: Map<string, { targetPath: string; exportedName: string }>;
  namespaceImports: Map<string, string>; // local ns name -> module path
  localFunctions: Map<string, ts.Node>;
  exportedFunctions: Map<string, ts.Node>;
  presenceInstances: Set<string>;
  exportedInstanceNames: Set<string>;
  hasDefaultInstanceExport: boolean;
}

interface SourceAnalysis {
  constructsPresenceClient: boolean;
  endpointComponentCalls: Record<EndpointName, Set<string>>;
}

function analyzeAuthoredConvexSources(): SourceAnalysis {
  const modules = readAuthoredModules();
  const modulesByPath = new Map(modules.map((m) => [m.path, m]));

  // Iteratively propagate presence instances across module boundaries
  // (import { presence } from "./presenceClient", default imports, and
  // namespace member access are all resolved by the walkers below).
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
      // Re-derive exports in case an imported instance is re-exported.
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
                  modulesByPath,
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

  const constructsPresenceClient = modules.some(
    (module) => module.presenceInstances.size > 0,
  );

  const endpointComponentCalls: Record<EndpointName, Set<string>> = {
    heartbeat: new Set(),
    list: new Set(),
    disconnect: new Set(),
  };

  for (const module of modules) {
    for (const endpointName of ENDPOINT_NAMES) {
      const handler = findEndpointHandler(module, endpointName);
      if (handler === undefined) continue;
      collectComponentCallsOnPath(
        module,
        modulesByPath,
        handler,
        endpointComponentCalls[endpointName],
        0,
        new Set(),
      );
    }
  }

  return { constructsPresenceClient, endpointComponentCalls };
}

function readAuthoredModules(): SourceModule[] {
  const projectDir = getLatestOutputProjectDir(CATEGORY, EVAL_NAME);
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
  // Resolve relative import specifiers now that all module paths are known.
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
    if (specifier === "@convex-dev/presence") {
      const bindings = clause.namedBindings;
      if (bindings !== undefined && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          if ((element.propertyName ?? element.name).text === "Presence") {
            module.presenceCtorNames.add(element.name.text);
          }
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
    const targetPath = resolveLocalModulePathFromSet(
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
  // Seed instances now that imports are known: local `new Presence(...)`.
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
      ctor.name.text === "Presence" &&
      ts.isIdentifier(ctor.expression) &&
      module.presenceNamespaces.has(ctor.expression.text));
  if (!ctorMatches) return false;
  const firstArg = resolved.arguments?.[0];
  if (firstArg === undefined) return false;
  // The task mounts the component and passes its generated api reference;
  // accept any components.* chain (custom mount names still delegate).
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

/**
 * Flatten a property-access chain rooted at a `components` binding (resolving
 * const aliases like `const p = components.presence`). Returns the property
 * segments after `components`, or undefined when the expression is not a
 * components chain.
 */
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
      // Root may itself be a const alias of a components chain.
      const aliased = module.declarations.get(resolved.text);
      if (aliased !== undefined) {
        const viaAlias = componentsChainSegments(
          { ...module, declarations: new Map() } as SourceModule,
          aliased,
        );
        // Fall through when the alias is not resolvable without declarations.
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
        // Tolerate the legacy function-form definition; the function spec
        // comparison still enforces the declared argument validators.
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
 * Walk an endpoint's call path (handler plus local/imported helpers, depth
 * <= 4) and record every presence-component operation it can reach: methods
 * invoked on a Presence instance, and direct ctx.run* calls whose function
 * reference is a components.* chain (last segment recorded).
 */
function collectComponentCallsOnPath(
  module: SourceModule,
  modulesByPath: Map<string, SourceModule>,
  root: ts.Node,
  reached: Set<string>,
  depth: number,
  visiting: Set<ts.Node>,
): void {
  if (depth > 4 || visiting.has(root)) return;
  visiting.add(root);

  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      if (ts.isPropertyAccessExpression(node.expression)) {
        const method = node.expression.name.text;
        const receiver = node.expression.expression;
        if (isPresenceInstanceExpression(module, modulesByPath, receiver)) {
          reached.add(method);
        }
        if (
          ["runQuery", "runMutation", "runAction"].includes(method) &&
          node.arguments.length >= 1
        ) {
          const segments = componentsChainSegments(module, node.arguments[0]);
          if (segments !== undefined && segments.length > 0) {
            reached.add(segments[segments.length - 1]);
          }
        }
        // Helper invoked through a namespace import: ns.helper(...).
        if (ts.isIdentifier(receiver)) {
          const targetPath = module.namespaceImports.get(receiver.text);
          const target =
            targetPath === undefined
              ? undefined
              : modulesByPath.get(targetPath);
          const helper = target?.exportedFunctions.get(method);
          if (target !== undefined && helper !== undefined) {
            collectComponentCallsOnPath(
              target,
              modulesByPath,
              helper,
              reached,
              depth + 1,
              visiting,
            );
          }
        }
      } else if (ts.isIdentifier(node.expression)) {
        const name = node.expression.text;
        const local = module.localFunctions.get(name);
        if (local !== undefined) {
          collectComponentCallsOnPath(
            module,
            modulesByPath,
            local,
            reached,
            depth + 1,
            visiting,
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
            collectComponentCallsOnPath(
              target,
              modulesByPath,
              helper,
              reached,
              depth + 1,
              visiting,
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

function hasPresenceMount(sourceText: string): boolean {
  const sourceFile = ts.createSourceFile(
    "convex.config.ts",
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const presenceImports = new Set<string>();
  const presenceNamespaces = new Set<string>();
  const declarations = collectConstDeclarations(sourceFile);

  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !/^@convex-dev\/presence\/convex\.config(?:\.js)?$/.test(
        statement.moduleSpecifier.text,
      )
    ) {
      continue;
    }
    const defaultImport = statement.importClause?.name;
    if (defaultImport !== undefined) presenceImports.add(defaultImport.text);
    const bindings = statement.importClause?.namedBindings;
    if (bindings !== undefined && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        if ((element.propertyName ?? element.name).text === "default") {
          presenceImports.add(element.name.text);
        }
      }
    } else if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
      presenceNamespaces.add(bindings.name.text);
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
        (ts.isIdentifier(component) && presenceImports.has(component.text)) ||
        (ts.isPropertyAccessExpression(component) &&
          component.name.text === "default" &&
          ts.isIdentifier(component.expression) &&
          presenceNamespaces.has(component.expression.text))
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
  modulesByPath: Map<string, SourceModule>,
): string | undefined {
  return resolveLocalModulePathFromSet(
    importerPath,
    specifier,
    new Set(modulesByPath.keys()),
  );
}

function resolveLocalModulePathFromSet(
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
