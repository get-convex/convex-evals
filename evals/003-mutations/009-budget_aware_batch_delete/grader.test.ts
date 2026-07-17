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
function metricsWithRemainingAccess(sources: ts.SourceFile[]): Set<string> {
  const satisfied = new Set<string>();
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
      } else if (ts.isObjectBindingPattern(element.name)) {
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

interface SchedulerCall {
  call: ts.CallExpression;
  file: string;
  targetsInternal: boolean;
  exitsImmediately: boolean;
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

function collectSchedulerCalls(sources: ts.SourceFile[]): SchedulerCall[] {
  const { isInternalRooted, internalAliases } = collectInternalRoots(sources);

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
