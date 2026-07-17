import { expect, test, beforeEach } from "vitest";
import {
  addDocuments,
  compareFunctionSpec,
  compareSchema,
  deleteAllDocuments,
  getLatestOutputProjectDir,
  listTable,
  pollUntil,
  responseAdminClient,
  responseClient,
} from "../../../grader";
import { anyApi } from "convex/server";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const CATEGORY = "003-mutations";
const EVAL_NAME = "009-budget_aware_batch_delete";

// The task caps payloads at 400 KiB; the behavioral seeds use the cap itself.
const MAX_PAYLOAD = "x".repeat(400 * 1024);
const SMALL_PAYLOAD = "y".repeat(1024);

interface RecordDoc {
  workspaceId: string;
  archived: boolean;
  payload: string;
}

// Seed in chunks so no single system mutation carries an oversized argument.
async function seedRecords(docs: RecordDoc[], chunkSize: number) {
  for (let i = 0; i < docs.length; i += chunkSize) {
    await addDocuments(
      responseAdminClient,
      "records",
      docs.slice(i, i + chunkSize),
    );
  }
}

async function allRecords(): Promise<RecordDoc[]> {
  return (await listTable(
    responseAdminClient,
    "records",
    200,
  )) as unknown as RecordDoc[];
}

beforeEach(async () => {
  await deleteAllDocuments(responseAdminClient, ["records"]);
});

test("compare schema", async ({ skip }) => {
  await compareSchema(skip);
});

test("compare function spec", async ({ skip }) => {
  await compareFunctionSpec(skip, { ignoreReturns: true, publicOnly: true });
});

test(
  "deletes an archive too large for any single transaction",
  { timeout: 120_000 },
  async () => {
    // 24 x 400 KiB archived records: scanning and deleting all of ws-large in
    // one transaction costs ~19.7 MB of bytesRead (each deleted record is
    // read once by the query and once by the delete), past the 16 MiB hard
    // limit. Implementations that ignore the metrics crash mid-job here.
    const targets: RecordDoc[] = Array.from({ length: 24 }, () => ({
      workspaceId: "ws-large",
      archived: true,
      payload: MAX_PAYLOAD,
    }));
    const decoys: RecordDoc[] = [
      { workspaceId: "ws-large", archived: false, payload: SMALL_PAYLOAD },
      { workspaceId: "ws-large", archived: false, payload: SMALL_PAYLOAD },
      { workspaceId: "ws-other", archived: true, payload: SMALL_PAYLOAD },
      { workspaceId: "ws-other", archived: true, payload: SMALL_PAYLOAD },
    ];
    await seedRecords(targets, 4);
    await seedRecords(decoys, 4);

    await responseClient.mutation(anyApi.index.deleteArchivedRecords, {
      workspaceId: "ws-large",
    });

    await pollUntil(
      async () => {
        const rows = await allRecords();
        return rows.every((r) => !(r.workspaceId === "ws-large" && r.archived));
      },
      { timeoutMs: 60_000, intervalMs: 500 },
    );

    const rows = await allRecords();
    expect(
      rows.filter((r) => r.workspaceId === "ws-large" && r.archived),
    ).toHaveLength(0);
    expect(
      rows.filter((r) => r.workspaceId === "ws-large" && !r.archived),
    ).toHaveLength(2);
    expect(rows.filter((r) => r.workspaceId === "ws-other")).toHaveLength(2);
  },
);

test(
  "deletes small records across metric-driven continuations",
  { timeout: 60_000 },
  async () => {
    // 23 x 1 KiB records barely move the byte budgets, so only the
    // documentsRead/documentsWritten reserves can drive the continuation
    // chain here - the byte reserves alone are not enough.
    const targets: RecordDoc[] = Array.from({ length: 23 }, () => ({
      workspaceId: "ws-batch",
      archived: true,
      payload: SMALL_PAYLOAD,
    }));
    const decoys: RecordDoc[] = [
      { workspaceId: "ws-batch", archived: false, payload: SMALL_PAYLOAD },
      { workspaceId: "ws-batch", archived: false, payload: SMALL_PAYLOAD },
      { workspaceId: "ws-batch", archived: false, payload: SMALL_PAYLOAD },
      { workspaceId: "ws-keep", archived: true, payload: SMALL_PAYLOAD },
      { workspaceId: "ws-keep", archived: true, payload: SMALL_PAYLOAD },
      { workspaceId: "ws-keep", archived: true, payload: SMALL_PAYLOAD },
    ];
    await seedRecords(targets, 23);
    await seedRecords(decoys, 6);

    await responseClient.mutation(anyApi.index.deleteArchivedRecords, {
      workspaceId: "ws-batch",
    });

    await pollUntil(
      async () => {
        const rows = await allRecords();
        return rows.every((r) => !(r.workspaceId === "ws-batch" && r.archived));
      },
      { timeoutMs: 30_000, intervalMs: 250 },
    );

    const rows = await allRecords();
    expect(
      rows.filter((r) => r.workspaceId === "ws-batch" && r.archived),
    ).toHaveLength(0);
    expect(
      rows.filter((r) => r.workspaceId === "ws-batch" && !r.archived),
    ).toHaveLength(3);
    expect(rows.filter((r) => r.workspaceId === "ws-keep")).toHaveLength(3);
  },
);

test(
  "a workspace with no archived records is a no-op",
  { timeout: 30_000 },
  async () => {
    const decoys: RecordDoc[] = [
      { workspaceId: "ws-empty", archived: false, payload: SMALL_PAYLOAD },
      { workspaceId: "ws-other", archived: true, payload: SMALL_PAYLOAD },
    ];
    await seedRecords(decoys, 2);

    await responseClient.mutation(anyApi.index.deleteArchivedRecords, {
      workspaceId: "ws-empty",
    });

    const rows = await allRecords();
    expect(rows).toHaveLength(2);
    expect(
      rows.filter((r) => r.workspaceId === "ws-empty" && !r.archived),
    ).toHaveLength(1);
    expect(
      rows.filter((r) => r.workspaceId === "ws-other" && r.archived),
    ).toHaveLength(1);
  },
);

// ── AST analysis of the authored convex sources ──────────────────────

const METRIC_NAMES = [
  "bytesRead",
  "bytesWritten",
  "documentsRead",
  "documentsWritten",
];

function collectAuthoredSourceFiles(): ts.SourceFile[] {
  const walk = (dir: string): string[] => {
    const files: string[] = [];
    for (const entry of readdirSync(dir)) {
      if (entry === "_generated" || entry === "node_modules") continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) files.push(...walk(full));
      else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts"))
        files.push(full);
    }
    return files;
  };
  const convexDir = join(
    getLatestOutputProjectDir(CATEGORY, EVAL_NAME),
    "convex",
  );
  return walk(convexDir).map((file) =>
    ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    ),
  );
}

function visitAll(
  sources: ts.SourceFile[],
  visit: (node: ts.Node) => void,
): void {
  const recurse = (node: ts.Node) => {
    visit(node);
    ts.forEachChild(node, recurse);
  };
  for (const source of sources) recurse(source);
}

/** Calls like `.take(...)`, `.collect(...)`, `.paginate(...)`. */
function findBannedQueryCalls(sources: ts.SourceFile[]): string[] {
  const banned = new Set(["take", "collect", "paginate"]);
  const found: string[] = [];
  visitAll(sources, (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      banned.has(node.expression.name.text)
    ) {
      found.push(node.expression.name.text);
    }
  });
  return found;
}

function hasForAwaitLoop(sources: ts.SourceFile[]): boolean {
  let found = false;
  visitAll(sources, (node) => {
    if (ts.isForOfStatement(node) && node.awaitModifier !== undefined) {
      found = true;
    }
  });
  return found;
}

/** Walk up through parentheses to the outermost wrapping expression. */
function unwrapParens(node: ts.Node): ts.Node {
  let current = node;
  while (
    current.parent !== undefined &&
    ts.isParenthesizedExpression(current.parent)
  ) {
    current = current.parent;
  }
  return current;
}

/**
 * Count `getTransactionMetrics()` calls, and how many have their Promise
 * consumed: awaited directly, or returned/arrow-returned to an async caller.
 */
function countMetricsCalls(sources: ts.SourceFile[]): {
  total: number;
  awaited: number;
} {
  let total = 0;
  let awaited = 0;
  visitAll(sources, (node) => {
    if (
      !ts.isCallExpression(node) ||
      !ts.isPropertyAccessExpression(node.expression) ||
      node.expression.name.text !== "getTransactionMetrics"
    ) {
      return;
    }
    total++;
    const wrapped = unwrapParens(node);
    const parent = wrapped.parent;
    if (
      parent !== undefined &&
      (ts.isAwaitExpression(parent) ||
        ts.isReturnStatement(parent) ||
        (ts.isArrowFunction(parent) && parent.body === wrapped))
    ) {
      awaited++;
    }
  });
  return { total, awaited };
}

/**
 * Which of the four metrics have their `.remaining` consumed. Handles
 * property chains (`metrics.bytesRead.remaining`), literal element access
 * (`metrics["bytesRead"].remaining`), destructured aliases
 * (`const { bytesRead: br } = metrics` ... `br.remaining`), nested
 * destructuring (`const { bytesRead: { remaining } } = metrics`), and
 * data-driven loops (`metrics[key].remaining` over metric-name literals).
 */
function buildMetricAliasMap(sources: ts.SourceFile[]): Map<string, string> {
  const aliasToMetric = new Map<string, string>();
  visitAll(sources, (node) => {
    if (!ts.isObjectBindingPattern(node)) return;
    for (const element of node.elements) {
      const propNode = element.propertyName ?? element.name;
      if (!ts.isIdentifier(propNode)) continue;
      const prop = propNode.text;
      if (!METRIC_NAMES.includes(prop)) continue;
      if (ts.isIdentifier(element.name)) {
        aliasToMetric.set(element.name.text, prop);
      }
    }
  });
  return aliasToMetric;
}

function metricsWithRemainingAccess(sources: ts.SourceFile[]): Set<string> {
  const satisfied = new Set<string>();
  const aliasToMetric = buildMetricAliasMap(sources);

  visitAll(sources, (node) => {
    if (!ts.isObjectBindingPattern(node)) return;
    for (const element of node.elements) {
      const propNode = element.propertyName ?? element.name;
      if (!ts.isIdentifier(propNode)) continue;
      const prop = propNode.text;
      if (!METRIC_NAMES.includes(prop)) continue;
      if (ts.isObjectBindingPattern(element.name)) {
        for (const inner of element.name.elements) {
          const innerProp = inner.propertyName ?? inner.name;
          if (ts.isIdentifier(innerProp) && innerProp.text === "remaining") {
            satisfied.add(prop);
          }
        }
      }
    }
  });

  let computedRemainingAccess = false;
  visitAll(sources, (node) => {
    if (!ts.isPropertyAccessExpression(node) || node.name.text !== "remaining")
      return;
    const receiver = node.expression;
    if (
      ts.isPropertyAccessExpression(receiver) &&
      METRIC_NAMES.includes(receiver.name.text)
    ) {
      satisfied.add(receiver.name.text);
    } else if (ts.isIdentifier(receiver)) {
      const metric = aliasToMetric.get(receiver.text);
      if (metric !== undefined) satisfied.add(metric);
    } else if (ts.isElementAccessExpression(receiver)) {
      const arg = receiver.argumentExpression;
      if (ts.isStringLiteral(arg) && METRIC_NAMES.includes(arg.text)) {
        satisfied.add(arg.text);
      } else {
        computedRemainingAccess = true;
      }
    }
  });

  // Data-driven style: `metrics[key].remaining` where the metric names appear
  // as string literals (e.g. in an array the code iterates over).
  if (computedRemainingAccess) {
    visitAll(sources, (node) => {
      if (ts.isStringLiteral(node) && METRIC_NAMES.includes(node.text)) {
        satisfied.add(node.text);
      }
    });
  }

  return satisfied;
}

/**
 * Which of the four metrics a `.remaining` read belongs to. A computed
 * element access (`metrics[key].remaining`, the data-driven style) counts
 * for all four; the separate access check still requires the four names to
 * appear as literals.
 */
function metricRemainingAccessMetrics(
  node: ts.Node,
  aliasToMetric: Map<string, string>,
): string[] {
  if (!ts.isPropertyAccessExpression(node) || node.name.text !== "remaining") {
    return [];
  }
  const receiver = node.expression;
  if (
    ts.isPropertyAccessExpression(receiver) &&
    METRIC_NAMES.includes(receiver.name.text)
  ) {
    return [receiver.name.text];
  }
  if (ts.isIdentifier(receiver)) {
    const metric = aliasToMetric.get(receiver.text);
    return metric === undefined ? [] : [metric];
  }
  if (ts.isElementAccessExpression(receiver)) {
    const arg = receiver.argumentExpression;
    if (ts.isStringLiteral(arg)) {
      return METRIC_NAMES.includes(arg.text) ? [arg.text] : [];
    }
    return [...METRIC_NAMES];
  }
  return [];
}

/**
 * Identifier names whose values derive from a metric `.remaining` read,
 * mapped to WHICH metrics they derive from: named conditions
 * (`const reservesReached = m.bytesRead.remaining <= R`), destructured
 * `remaining` bindings, helper predicates whose body reads the metrics, and
 * flags assigned under a metric-derived condition. Computed to a fixpoint so
 * chains of aliases resolve and unions accumulate.
 */
function collectMetricDerivedNames(
  sources: ts.SourceFile[],
  aliasToMetric: Map<string, string>,
): Map<string, Set<string>> {
  const derived = new Map<string, Set<string>>();
  const attribute = (name: string, metrics: Iterable<string>) => {
    const existing = derived.get(name) ?? new Set<string>();
    for (const metric of metrics) existing.add(metric);
    if (existing.size > 0) derived.set(name, existing);
  };

  const subtreeMetrics = (root: ts.Node): Set<string> => {
    const found = new Set<string>();
    const walk = (n: ts.Node) => {
      for (const metric of metricRemainingAccessMetrics(n, aliasToMetric)) {
        found.add(metric);
      }
      if (ts.isIdentifier(n)) {
        const viaName = derived.get(n.text);
        if (viaName !== undefined) {
          for (const metric of viaName) found.add(metric);
        }
      }
      ts.forEachChild(n, walk);
    };
    walk(root);
    return found;
  };

  // Seed: destructuring that binds a metric's `remaining` to a name, e.g.
  // `const { remaining } = metrics.bytesRead` or
  // `const { bytesRead: { remaining: r } } = await ctx.meta.getTransactionMetrics()`.
  const initializerMetricMentions = (root: ts.Node): Set<string> => {
    const found = new Set<string>();
    let sawMetricsSource = false;
    const walk = (n: ts.Node) => {
      if (
        ts.isPropertyAccessExpression(n) &&
        METRIC_NAMES.includes(n.name.text)
      ) {
        found.add(n.name.text);
      }
      if (
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        n.expression.name.text === "getTransactionMetrics"
      ) {
        sawMetricsSource = true;
      }
      if (ts.isIdentifier(n) && aliasToMetric.has(n.text)) {
        found.add(aliasToMetric.get(n.text) as string);
      }
      ts.forEachChild(n, walk);
    };
    walk(root);
    if (found.size === 0 && sawMetricsSource) {
      for (const metric of METRIC_NAMES) found.add(metric);
    }
    return found;
  };
  const collectRemainingBindings = (
    pattern: ts.ObjectBindingPattern,
    context: Set<string>,
  ) => {
    for (const element of pattern.elements) {
      const propNode = element.propertyName ?? element.name;
      const propMetric =
        ts.isIdentifier(propNode) && METRIC_NAMES.includes(propNode.text)
          ? new Set([propNode.text])
          : context;
      if (
        ts.isIdentifier(propNode) &&
        propNode.text === "remaining" &&
        ts.isIdentifier(element.name)
      ) {
        attribute(element.name.text, context);
      } else if (ts.isObjectBindingPattern(element.name)) {
        collectRemainingBindings(element.name, propMetric);
      }
    }
  };
  visitAll(sources, (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer !== undefined &&
      ts.isObjectBindingPattern(node.name)
    ) {
      const mentions = initializerMetricMentions(node.initializer);
      if (mentions.size > 0) {
        collectRemainingBindings(node.name, mentions);
      }
    }
  });

  // Fixpoint: named values, helper predicates, and flag assignments.
  for (let pass = 0; pass < 6; pass++) {
    const before = [...derived.values()].reduce((n, s) => n + s.size, 0);
    visitAll(sources, (node) => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer !== undefined
      ) {
        attribute(node.name.text, subtreeMetrics(node.initializer));
      }
      if (
        ts.isFunctionDeclaration(node) &&
        node.name !== undefined &&
        node.body !== undefined
      ) {
        attribute(node.name.text, subtreeMetrics(node.body));
      }
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(node.left)
      ) {
        attribute(node.left.text, subtreeMetrics(node.right));
        // Flag style: `if (metric condition) { flag = true; break; }`.
        let current: ts.Node | undefined = node.parent;
        while (current !== undefined && !ts.isFunctionLike(current)) {
          if (ts.isIfStatement(current)) {
            attribute(node.left.text, subtreeMetrics(current.expression));
          } else if (ts.isConditionalExpression(current)) {
            attribute(node.left.text, subtreeMetrics(current.condition));
          }
          current = current.parent;
        }
      }
    });
    const after = [...derived.values()].reduce((n, s) => n + s.size, 0);
    if (after === before) break;
  }
  return derived;
}

interface SchedulerCall {
  call: ts.CallExpression;
  file: string;
  targetsInternal: boolean;
  exitsImmediately: boolean;
  guardMetrics: Set<string>;
}

/**
 * Names bound to the generated `internal` object: the plain/renamed named
 * import from `_generated/api`, plus namespace imports (`ns.internal`).
 */
function collectInternalRoots(sources: ts.SourceFile[]): {
  isInternalRooted: (text: string) => boolean;
  internalAliases: Set<string>;
} {
  const internalRoots = new Set<string>();
  const namespaceRoots = new Set<string>();
  visitAll(sources, (node) => {
    if (
      !ts.isImportDeclaration(node) ||
      node.importClause?.namedBindings === undefined ||
      !node.moduleSpecifier.getText().includes("_generated/api")
    ) {
      return;
    }
    const bindings = node.importClause.namedBindings;
    if (ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        const imported = element.propertyName?.text ?? element.name.text;
        if (imported === "internal") internalRoots.add(element.name.text);
      }
    } else if (ts.isNamespaceImport(bindings)) {
      namespaceRoots.add(bindings.name.text);
    }
  });

  const isInternalRooted = (text: string): boolean => {
    for (const root of internalRoots) {
      if (text === root || text.startsWith(`${root}.`)) return true;
    }
    for (const ns of namespaceRoots) {
      if (text === `${ns}.internal` || text.startsWith(`${ns}.internal.`)) {
        return true;
      }
    }
    return false;
  };

  // Aliases like `const fn = internal.index.continue;` and
  // `const { continue: fn } = internal.index;`.
  const internalAliases = new Set<string>();
  visitAll(sources, (node) => {
    if (
      !ts.isVariableDeclaration(node) ||
      node.initializer === undefined ||
      !isInternalRooted(node.initializer.getText())
    ) {
      return;
    }
    if (ts.isIdentifier(node.name)) {
      internalAliases.add(node.name.text);
    } else if (ts.isObjectBindingPattern(node.name)) {
      for (const element of node.name.elements) {
        if (ts.isIdentifier(element.name)) {
          internalAliases.add(element.name.text);
        }
      }
    }
  });

  return { isInternalRooted, internalAliases };
}

/**
 * True when nothing but a `return` (or loop `break`) can execute between this
 * call and the end of the enclosing function: scheduling the continuation
 * must be the batch's last act. Falling off the end of the function counts;
 * looping around for more work does not.
 */
function exitsImmediatelyAfter(call: ts.CallExpression): boolean {
  let stmt: ts.Node = call;
  while (!ts.isStatement(stmt)) {
    if (stmt.parent === undefined) return false;
    stmt = stmt.parent;
  }
  if (ts.isReturnStatement(stmt)) return true;
  for (;;) {
    const parent: ts.Node | undefined = stmt.parent;
    if (parent === undefined) return true;
    if (ts.isBlock(parent)) {
      const index = parent.statements.indexOf(stmt as ts.Statement);
      const next = parent.statements[index + 1];
      if (next !== undefined) {
        return ts.isReturnStatement(next) || ts.isBreakStatement(next);
      }
      stmt = parent;
      continue;
    }
    if (ts.isIfStatement(parent)) {
      stmt = parent;
      continue;
    }
    if (
      ts.isForOfStatement(parent) ||
      ts.isForInStatement(parent) ||
      ts.isForStatement(parent) ||
      ts.isWhileStatement(parent) ||
      ts.isDoStatement(parent)
    ) {
      return false;
    }
    if (ts.isFunctionLike(parent) || ts.isSourceFile(parent)) return true;
    stmt = parent;
  }
}

function enclosingFunction(node: ts.Node): ts.Node | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current !== undefined && !ts.isFunctionLike(current)) {
    current = current.parent;
  }
  return current;
}

/**
 * Metrics that drive conditions the given node sits under: if/ternary/loop
 * guards and short-circuits between the node and its enclosing function.
 */
function metricsFromAncestorConditions(
  node: ts.Node,
  subtreeMetrics: (n: ts.Node) => Set<string>,
): Set<string> {
  const found = new Set<string>();
  const absorb = (condition: ts.Node) => {
    for (const metric of subtreeMetrics(condition)) found.add(metric);
  };
  let previous: ts.Node = node;
  let current: ts.Node | undefined = node.parent;
  while (current !== undefined) {
    if (ts.isIfStatement(current)) {
      if (current.expression !== previous) absorb(current.expression);
    } else if (ts.isConditionalExpression(current)) {
      if (current.condition !== previous) absorb(current.condition);
    } else if (ts.isWhileStatement(current) || ts.isDoStatement(current)) {
      if (current.expression !== previous) absorb(current.expression);
    } else if (
      ts.isBinaryExpression(current) &&
      (current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        current.operatorToken.kind === ts.SyntaxKind.BarBarToken) &&
      current.right === previous
    ) {
      absorb(current.left);
    } else if (ts.isFunctionLike(current)) {
      return found;
    }
    previous = current;
    current = current.parent;
  }
  return found;
}

/**
 * Metrics that drive a jump decision (return/break/continue branch, or a
 * loop guard) somewhere in the function - i.e. metrics that actually decide
 * where a batch ends. Covers guard-clause and flag+break styles that
 * `metricsFromAncestorConditions` alone would miss.
 */
function metricsFromGuardedJumps(
  fn: ts.Node,
  subtreeMetrics: (n: ts.Node) => Set<string>,
): Set<string> {
  const found = new Set<string>();
  const containsJump = (root: ts.Node | undefined): boolean => {
    if (root === undefined) return false;
    let jump = false;
    const walk = (n: ts.Node) => {
      if (jump) return;
      if (
        ts.isReturnStatement(n) ||
        ts.isBreakStatement(n) ||
        ts.isContinueStatement(n)
      ) {
        jump = true;
        return;
      }
      if (ts.isFunctionLike(n)) return;
      ts.forEachChild(n, walk);
    };
    walk(root);
    return jump;
  };
  const walk = (n: ts.Node) => {
    if (ts.isFunctionLike(n) && n !== fn) return;
    if (
      ts.isIfStatement(n) &&
      (containsJump(n.thenStatement) || containsJump(n.elseStatement))
    ) {
      for (const metric of subtreeMetrics(n.expression)) found.add(metric);
    }
    if (ts.isWhileStatement(n) || ts.isDoStatement(n)) {
      for (const metric of subtreeMetrics(n.expression)) found.add(metric);
    }
    ts.forEachChild(n, walk);
  };
  if (ts.isFunctionLike(fn)) {
    const body = (fn as ts.FunctionLikeDeclaration).body;
    if (body !== undefined) walk(body);
  } else {
    walk(fn);
  }
  return found;
}

function functionName(fn: ts.Node | undefined): string | undefined {
  if (fn === undefined) return undefined;
  if (ts.isFunctionDeclaration(fn) && fn.name !== undefined) {
    return fn.name.text;
  }
  if (
    (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) &&
    fn.parent !== undefined &&
    ts.isVariableDeclaration(fn.parent) &&
    ts.isIdentifier(fn.parent.name)
  ) {
    return fn.parent.name.text;
  }
  return undefined;
}

interface CalleeDeclaration {
  parameters: readonly ts.ParameterDeclaration[];
  body: ts.Node;
}

/**
 * Resolve a call expression's callee name to function declarations in the
 * authored sources (function declarations and const arrow/function values).
 */
function resolveCalleeDeclarations(
  sources: ts.SourceFile[],
  call: ts.CallExpression,
): CalleeDeclaration[] {
  const callee = call.expression;
  const name = ts.isIdentifier(callee)
    ? callee.text
    : ts.isPropertyAccessExpression(callee)
      ? callee.name.text
      : undefined;
  if (name === undefined) return [];
  const declarations: CalleeDeclaration[] = [];
  visitAll(sources, (node) => {
    if (
      ts.isFunctionDeclaration(node) &&
      node.name !== undefined &&
      node.name.text === name &&
      node.body !== undefined
    ) {
      declarations.push({ parameters: node.parameters, body: node.body });
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer !== undefined &&
      (ts.isArrowFunction(node.initializer) ||
        ts.isFunctionExpression(node.initializer)) &&
      node.initializer.body !== undefined
    ) {
      declarations.push({
        parameters: node.initializer.parameters,
        body: node.initializer.body,
      });
    }
  });
  return declarations;
}

function collectSchedulerCalls(sources: ts.SourceFile[]): SchedulerCall[] {
  const { isInternalRooted, internalAliases } = collectInternalRoots(sources);
  const aliasToMetric = buildMetricAliasMap(sources);
  const derivedNames = collectMetricDerivedNames(sources, aliasToMetric);
  const subtreeMetrics = (root: ts.Node): Set<string> => {
    const found = new Set<string>();
    const walk = (n: ts.Node) => {
      for (const metric of metricRemainingAccessMetrics(n, aliasToMetric)) {
        found.add(metric);
      }
      if (ts.isIdentifier(n)) {
        const viaName = derivedNames.get(n.text);
        if (viaName !== undefined) {
          for (const metric of viaName) found.add(metric);
        }
      }
      ts.forEachChild(n, walk);
    };
    walk(root);
    return found;
  };

  // The batch boundary must be decided by the metrics: the scheduler call
  // itself sits under metric-derived conditions, or its enclosing function
  // makes metric-derived jump decisions, or - for a schedule-only helper -
  // its call sites do. The union of metrics driving those decisions is what
  // the call is graded on.
  const guardMetricsFor = (call: ts.CallExpression): Set<string> => {
    const metrics = new Set<string>();
    const absorb = (more: Iterable<string>) => {
      for (const metric of more) metrics.add(metric);
    };
    absorb(metricsFromAncestorConditions(call, subtreeMetrics));
    const fn = enclosingFunction(call);
    if (fn !== undefined) {
      absorb(metricsFromGuardedJumps(fn, subtreeMetrics));
    }
    const name = functionName(fn);
    if (name !== undefined) {
      visitAll(sources, (node) => {
        if (!ts.isCallExpression(node) || node === call) return;
        const callee = node.expression;
        const calleeName = ts.isIdentifier(callee)
          ? callee.text
          : ts.isPropertyAccessExpression(callee)
            ? callee.name.text
            : "";
        if (calleeName !== name) return;
        absorb(metricsFromAncestorConditions(node, subtreeMetrics));
        const callerFn = enclosingFunction(node);
        if (callerFn !== undefined) {
          absorb(metricsFromGuardedJumps(callerFn, subtreeMetrics));
        }
      });
    }
    // Callback style: the scheduler call lives in an anonymous function
    // passed as an argument (`helper(ctx, ws, async () => { ...runAfter... })`).
    // Resolve the receiving parameter and grade the parameter's invocation
    // sites inside the callee instead.
    if (
      fn !== undefined &&
      fn.parent !== undefined &&
      ts.isCallExpression(fn.parent)
    ) {
      const outerCall = fn.parent;
      const argIndex = outerCall.arguments.findIndex(
        (argument) => argument === fn,
      );
      if (argIndex >= 0) {
        for (const declaration of resolveCalleeDeclarations(
          sources,
          outerCall,
        )) {
          const parameter = declaration.parameters[argIndex];
          if (parameter === undefined || !ts.isIdentifier(parameter.name)) {
            continue;
          }
          const parameterName = parameter.name.text;
          const walkBody = (n: ts.Node) => {
            if (
              ts.isCallExpression(n) &&
              ts.isIdentifier(n.expression) &&
              n.expression.text === parameterName
            ) {
              absorb(metricsFromAncestorConditions(n, subtreeMetrics));
              const invokerFn = enclosingFunction(n);
              if (invokerFn !== undefined) {
                absorb(metricsFromGuardedJumps(invokerFn, subtreeMetrics));
              }
            }
            ts.forEachChild(n, walkBody);
          };
          walkBody(declaration.body);
        }
      }
    }
    return metrics;
  };

  // Internal references handed to helpers as parameters:
  // `helper(ctx, ws, internal.index.foo)` makes the receiving parameter an
  // internal alias inside the helper body.
  visitAll(sources, (node) => {
    if (!ts.isCallExpression(node)) return;
    node.arguments.forEach((argument, index) => {
      const isInternalArg =
        isInternalRooted(argument.getText()) ||
        (ts.isIdentifier(argument) && internalAliases.has(argument.text));
      if (!isInternalArg) return;
      for (const declaration of resolveCalleeDeclarations(sources, node)) {
        const parameter = declaration.parameters[index];
        if (parameter !== undefined && ts.isIdentifier(parameter.name)) {
          internalAliases.add(parameter.name.text);
        }
      }
    });
  });

  // Aliases of the scheduler itself: `const s = ctx.scheduler;`.
  const schedulerAliases = new Set<string>(["scheduler"]);
  visitAll(sources, (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      ts.isPropertyAccessExpression(node.initializer) &&
      node.initializer.name.text === "scheduler"
    ) {
      schedulerAliases.add(node.name.text);
    }
  });

  const targetIsInternal = (target: ts.Expression | undefined): boolean => {
    if (target === undefined) return false;
    if (isInternalRooted(target.getText())) return true;
    let root: ts.Expression = target;
    while (ts.isPropertyAccessExpression(root)) root = root.expression;
    return ts.isIdentifier(root) && internalAliases.has(root.text);
  };

  const calls: SchedulerCall[] = [];
  visitAll(sources, (node) => {
    if (!ts.isCallExpression(node)) return;
    const callee = node.expression;
    if (
      !ts.isPropertyAccessExpression(callee) ||
      (callee.name.text !== "runAfter" && callee.name.text !== "runAt")
    ) {
      return;
    }
    const receiver = callee.expression;
    const isScheduler =
      (ts.isPropertyAccessExpression(receiver) &&
        receiver.name.text === "scheduler") ||
      (ts.isIdentifier(receiver) && schedulerAliases.has(receiver.text));
    if (!isScheduler) return;
    calls.push({
      call: node,
      file: node.getSourceFile().fileName,
      targetsInternal: targetIsInternal(node.arguments[1]),
      exitsImmediately: exitsImmediatelyAfter(node),
      guardMetrics: guardMetricsFor(node),
    });
  });
  return calls;
}

test("budget checks drive the continuation control flow", () => {
  const sources = collectAuthoredSourceFiles();
  expect(sources.length).toBeGreaterThan(0);

  const banned = findBannedQueryCalls(sources);
  expect(
    banned,
    "must not use .take()/.collect()/.paginate() - batch boundaries must come from the transaction metrics",
  ).toEqual([]);

  expect(
    hasForAwaitLoop(sources),
    "records must be consumed with `for await (const record of ...)` async iteration",
  ).toBe(true);

  const metricsCalls = countMetricsCalls(sources);
  expect(
    metricsCalls.total,
    "the deletion loop must consult ctx.meta.getTransactionMetrics()",
  ).toBeGreaterThan(0);
  expect(
    metricsCalls.awaited,
    "ctx.meta.getTransactionMetrics() returns a Promise and must be awaited",
  ).toBeGreaterThan(0);

  const satisfied = metricsWithRemainingAccess(sources);
  for (const metric of METRIC_NAMES) {
    expect(
      satisfied.has(metric),
      `the ${metric}.remaining reserve must be checked (used alone is not a reserve check)`,
    ).toBe(true);
  }

  const schedulerCalls = collectSchedulerCalls(sources);
  expect(
    schedulerCalls.length,
    "hitting a reserve must schedule the continuation via ctx.scheduler",
  ).toBeGreaterThan(0);
  for (const schedulerCall of schedulerCalls) {
    expect(
      schedulerCall.targetsInternal,
      `the continuation scheduled in ${schedulerCall.file} must be an internal function`,
    ).toBe(true);
    expect(
      schedulerCall.exitsImmediately,
      `the mutation in ${schedulerCall.file} must return immediately after scheduling the continuation`,
    ).toBe(true);
    expect(
      schedulerCall.guardMetrics.size,
      `the continuation in ${schedulerCall.file} must be scheduled because a .remaining reserve was hit - a batch boundary not decided by the transaction metrics does not count`,
    ).toBeGreaterThan(0);
    for (const metric of METRIC_NAMES) {
      expect(
        schedulerCall.guardMetrics.has(metric),
        `the ${metric}.remaining reserve must participate in the decision that schedules the continuation in ${schedulerCall.file} - reading it without letting it drive the batch boundary does not count`,
      ).toBe(true);
    }
  }

  // One continuation per batch: no handler (or helper) schedules twice.
  const perFunction = new Map<ts.Node | undefined, number>();
  for (const schedulerCall of schedulerCalls) {
    const fn = enclosingFunction(schedulerCall.call);
    perFunction.set(fn, (perFunction.get(fn) ?? 0) + 1);
  }
  for (const count of perFunction.values()) {
    expect(
      count,
      "each deletion routine must schedule exactly one continuation",
    ).toBe(1);
  }
});
