import { expect, test, beforeEach } from "vitest";
import {
  addDocuments,
  compareFunctionSpec,
  compareSchema,
  deleteAllDocuments,
  getLatestOutputProjectDir,
  listTable,
  responseAdminClient,
  responseClient,
} from "../../../grader";
import { anyApi, makeFunctionReference } from "convex/server";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const CATEGORY = "002-queries";
const EVAL_NAME = "026-scheduled_flag_materialization";

interface Subscription {
  _id: string;
  plan: string;
  expiresAt: number;
  isExpired: boolean;
}

beforeEach(async () => {
  await deleteAllDocuments(responseAdminClient, ["subscriptions"]);
});

async function listActive(): Promise<Subscription[]> {
  return (await responseClient.query(
    anyApi.index.listActive,
    {},
  )) as Subscription[];
}

async function allRows(): Promise<Subscription[]> {
  return (await listTable(
    responseAdminClient,
    "subscriptions",
    200,
  )) as Subscription[];
}

async function rowByPlan(plan: string): Promise<Subscription> {
  const rows = await allRows();
  const row = rows.find((r) => r.plan === plan);
  expect(
    row,
    `the seeded subscription with plan "${plan}" must still exist - keep the flag in sync by patching it, not by deleting rows`,
  ).toBeDefined();
  return row!;
}

type CronSchedule =
  | { type: "interval"; seconds: number | bigint | string }
  | { type: "cron"; cronExpr: string };

type CronJob = {
  name: string;
  cronSpec: {
    cronSchedule: CronSchedule;
    udfPath: string;
    udfArgs?: unknown;
  };
};

/**
 * The system query returns the cron's registered arguments as UTF-8 bytes
 * holding a JSON array with the single args object (e.g. "[{}]"). Decode
 * them so the marking mutation can be invoked exactly the way its cron
 * invokes it, whatever arguments the solution chose to register.
 */
function decodeCronArgs(udfArgs: unknown): Record<string, unknown> {
  if (!(udfArgs instanceof ArrayBuffer)) return {};
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(udfArgs));
    const first: unknown = Array.isArray(parsed) ? parsed[0] : parsed;
    return first !== null && typeof first === "object" && !Array.isArray(first)
      ? (first as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

type AdminClient = {
  query: (name: string, args: Record<string, unknown>) => Promise<unknown>;
};

async function getCronJobs(): Promise<CronJob[]> {
  const adminClient = responseAdminClient as unknown as AdminClient;
  return (await adminClient.query(
    "_system/frontend/listCronJobs",
    {},
  )) as CronJob[];
}

function describeSchedule(schedule: CronSchedule): string {
  return JSON.stringify(schedule, (_key, value) =>
    typeof value === "bigint" ? Number(value) : value,
  );
}

function runsAtLeastEveryMinute(schedule: CronSchedule): boolean {
  if (schedule.type === "interval") {
    const seconds = Number(schedule.seconds);
    return Number.isFinite(seconds) && seconds > 0 && seconds <= 60;
  }
  // Five-field cron expressions have minute granularity: they fire every
  // minute exactly when the minute field is unrestricted and the remaining
  // fields are wildcards.
  const fields = schedule.cronExpr.trim().split(/\s+/);
  return (
    fields.length === 5 &&
    ["*", "*/1"].includes(fields[0]) &&
    fields.slice(1).every((field) => field === "*")
  );
}

/**
 * The task never says HOW `isExpired` stays fresh - registering a cron that
 * drives an internal mutation IS the design under test. Discover the
 * registered cron, check its cadence honors the one-minute bound, check its
 * target is an internal mutation, and hand back a way to invoke that target
 * directly so behavioral tests never have to wait on the scheduler.
 */
async function discoverMarker(): Promise<{ invoke: () => Promise<void> }> {
  const cronJobs = await getCronJobs();
  expect(
    cronJobs,
    "exactly one cron job must keep the expiry flag fresh",
  ).toHaveLength(1);
  const [job] = cronJobs;
  expect(
    runsAtLeastEveryMinute(job.cronSpec.cronSchedule),
    `the cron must run at least once a minute to honor the freshness bound, got ${describeSchedule(job.cronSpec.cronSchedule)}`,
  ).toBe(true);

  const udfPath = job.cronSpec.udfPath;
  const adminClient = responseAdminClient as unknown as AdminClient;
  const spec = (await adminClient.query("_system/cli/modules:apiSpec", {})) as {
    identifier: string;
    functionType: string;
    visibility?: { kind?: string };
  }[];
  const target = spec.find((entry) => entry.identifier === udfPath);
  expect(
    target,
    `the cron's target ${udfPath} must be a function in this deployment`,
  ).toBeDefined();
  expect(
    target!.functionType,
    "the cron's target must be a mutation - marking rows is a plain database write",
  ).toBe("Mutation");
  expect(
    target!.visibility?.kind,
    "the marking mutation is invoked only by the scheduler, so it must be internal, not public",
  ).toBe("internal");

  const reference = makeFunctionReference<"mutation">(
    udfPath.replace(/\.js:/, ":"),
  );
  const args = decodeCronArgs(job.cronSpec.udfArgs);
  return {
    invoke: async () => {
      await responseAdminClient.mutation(reference, args);
    },
  };
}

test("compare schema", async ({ skip }) => {
  await compareSchema(skip);
});

test("compare public function spec", async ({ skip }) => {
  await compareFunctionSpec(skip, { ignoreReturns: true, publicOnly: true });
});

test(
  "a single cron drives an internal marking mutation at least every minute",
  { timeout: 30_000 },
  async () => {
    await discoverMarker();
  },
);

test(
  "listActive derives from the materialized flag, not the wall clock",
  { timeout: 30_000 },
  async () => {
    const now = Date.now();
    // Inserted deliberately out of expiration order. The marked/unmarked
    // states are chosen so a query that consults the real clock (in either
    // direction, or mixed with the flag) diverges from the flag-based answer.
    await addDocuments(responseAdminClient, "subscriptions", [
      { plan: "future-far", expiresAt: now + 90 * 60_000, isExpired: false },
      { plan: "past-marked", expiresAt: now - 60 * 60_000, isExpired: true },
      { plan: "past-unmarked", expiresAt: now - 5 * 60_000, isExpired: false },
      { plan: "future-marked", expiresAt: now + 60 * 60_000, isExpired: true },
      { plan: "future-near", expiresAt: now + 30 * 60_000, isExpired: false },
    ]);

    const active = await listActive();
    const names = active.map((doc) => doc.plan);

    // Race-free invariant: every returned document carries isExpired: false.
    // A query filtering on expiresAt vs the real clock would return the
    // "future-marked" row, whose own payload says isExpired: true.
    for (const doc of active) {
      expect(
        doc.isExpired,
        `listActive returned "${doc.plan}" even though its isExpired flag is true`,
      ).toBe(false);
    }

    expect(names).toContain("future-near");
    expect(names).toContain("future-far");
    expect(names).not.toContain("past-marked");

    // The registered cron may legitimately fire while this test runs, so the
    // two clock-divergent seeds are asserted against the row's current flag
    // state (flag transitions are monotonic for each row, which makes these
    // conditions race-free):
    // - "past-unmarked" must be listed while its flag is still false. Leaving
    //   it out means the query compared expiresAt against the real clock.
    const pastUnmarked = await rowByPlan("past-unmarked");
    if (!pastUnmarked.isExpired) {
      expect(
        names,
        "a not-yet-marked subscription must stay listed even when its expiresAt has passed - expiry state changes only when the flag flips",
      ).toContain("past-unmarked");
    }
    // - "future-marked" must not be listed while its flag is still true.
    const futureMarked = await rowByPlan("future-marked");
    if (futureMarked.isExpired) {
      expect(
        names,
        "a subscription whose isExpired flag is true must not be listed, even when its expiresAt is in the future",
      ).not.toContain("future-marked");
    }

    // Ascending expiresAt order over whatever was returned.
    for (let i = 1; i < active.length; i++) {
      expect(active[i - 1].expiresAt).toBeLessThanOrEqual(active[i].expiresAt);
    }
    if (!pastUnmarked.isExpired && futureMarked.isExpired) {
      expect(names).toEqual(["past-unmarked", "future-near", "future-far"]);
    }
  },
);

test(
  "the marking mutation flips exactly the overdue flags and listActive follows",
  { timeout: 30_000 },
  async () => {
    const marker = await discoverMarker();
    const now = Date.now();
    await addDocuments(responseAdminClient, "subscriptions", [
      { plan: "overdue-a", expiresAt: now - 10 * 60_000, isExpired: false },
      { plan: "overdue-b", expiresAt: now - 45_000, isExpired: false },
      { plan: "future-c", expiresAt: now + 60 * 60_000, isExpired: false },
      { plan: "already-d", expiresAt: now - 60 * 60_000, isExpired: true },
    ]);

    await marker.invoke();

    expect(
      (await rowByPlan("overdue-a")).isExpired,
      "a subscription 10 minutes past expiresAt must be marked",
    ).toBe(true);
    expect(
      (await rowByPlan("overdue-b")).isExpired,
      "a subscription 45 seconds past expiresAt must be marked - the freshness bound leaves no room for a grace margin",
    ).toBe(true);
    expect(
      (await rowByPlan("future-c")).isExpired,
      "a subscription that has not reached expiresAt must not be marked",
    ).toBe(false);
    expect(
      (await rowByPlan("already-d")).isExpired,
      "an already-marked subscription must stay marked",
    ).toBe(true);

    expect((await listActive()).map((doc) => doc.plan)).toEqual(["future-c"]);

    // Running the marker again must be a no-op.
    await marker.invoke();
    expect((await rowByPlan("future-c")).isExpired).toBe(false);
    expect((await listActive()).map((doc) => doc.plan)).toEqual(["future-c"]);
  },
);

function collectAuthoredSources(): ts.SourceFile[] {
  const convexDir = join(
    getLatestOutputProjectDir(CATEGORY, EVAL_NAME),
    "convex",
  );
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === "_generated" || entry === "node_modules") continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts"))
        files.push(full);
    }
  };
  walk(convexDir);
  return files.map((file) =>
    ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    ),
  );
}

/**
 * Wall-clock reads are banned inside query handlers only: the marking
 * mutation legitimately calls Date.now(). Query registrations are resolved
 * through however the file imports the builders from _generated/server
 * (named, renamed, namespace, or a const alias), and the entire registration
 * expression is scanned so helpers inlined into the handler are covered.
 */
function findQueryWallClockReads(source: ts.SourceFile): string[] {
  const builderNames = new Set<string>();
  const namespaceNames = new Set<string>();

  const collectImports = (node: ts.Node) => {
    if (
      ts.isImportDeclaration(node) &&
      node.importClause?.namedBindings !== undefined &&
      ts.isStringLiteralLike(node.moduleSpecifier) &&
      node.moduleSpecifier.text.includes("_generated/server")
    ) {
      const bindings = node.importClause.namedBindings;
      if (ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          const imported = element.propertyName?.text ?? element.name.text;
          if (imported === "query" || imported === "internalQuery") {
            builderNames.add(element.name.text);
          }
        }
      } else if (ts.isNamespaceImport(bindings)) {
        namespaceNames.add(bindings.name.text);
      }
    }
    ts.forEachChild(node, collectImports);
  };
  collectImports(source);

  const isQueryBuilder = (callee: ts.Expression): boolean => {
    if (ts.isIdentifier(callee)) return builderNames.has(callee.text);
    return (
      ts.isPropertyAccessExpression(callee) &&
      ts.isIdentifier(callee.expression) &&
      namespaceNames.has(callee.expression.text) &&
      (callee.name.text === "query" || callee.name.text === "internalQuery")
    );
  };

  // `const publicQuery = query;` style aliases also register queries.
  const collectAliases = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer !== undefined &&
      ts.isIdentifier(node.name) &&
      isQueryBuilder(node.initializer)
    ) {
      builderNames.add(node.name.text);
    }
    ts.forEachChild(node, collectAliases);
  };
  collectAliases(source);

  const isDateRef = (expr: ts.Expression): boolean => {
    if (ts.isIdentifier(expr) && expr.text === "Date") return true;
    return (
      ts.isPropertyAccessExpression(expr) &&
      expr.name.text === "Date" &&
      ts.isIdentifier(expr.expression) &&
      (expr.expression.text === "globalThis" ||
        expr.expression.text === "window")
    );
  };

  const reads: string[] = [];
  const scanForWallClock = (node: ts.Node) => {
    // Date.now(), globalThis.Date.now()
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "now" &&
      isDateRef(node.expression.expression)
    ) {
      reads.push("Date.now()");
    }
    // Bare Date() call - returns the current time as a string.
    if (ts.isCallExpression(node) && isDateRef(node.expression)) {
      reads.push("Date()");
    }
    // new Date() with no arguments; new Date(value) is a deterministic
    // conversion and stays allowed.
    if (
      ts.isNewExpression(node) &&
      isDateRef(node.expression) &&
      (node.arguments === undefined || node.arguments.length === 0)
    ) {
      reads.push("new Date()");
    }
    ts.forEachChild(node, scanForWallClock);
  };

  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && isQueryBuilder(node.expression)) {
      for (const argument of node.arguments) {
        scanForWallClock(argument);
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  return reads;
}

test("query handlers never read the wall clock", () => {
  const reads = collectAuthoredSources().flatMap((source) =>
    findQueryWallClockReads(source),
  );
  expect(
    reads,
    "queries must derive expiry from the materialized flag; wall-clock reads belong in the scheduled mutation",
  ).toEqual([]);
});
