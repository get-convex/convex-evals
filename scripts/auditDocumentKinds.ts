#!/usr/bin/env bun

import { join } from "node:path";

export const AUDIT_TABLES = ["runs", "evals", "modelScores"] as const;
export type AuditTable = (typeof AUDIT_TABLES)[number];

type Cursor = string | null;

export type AuditPage = {
  table: AuditTable;
  continueCursor: string;
  isDone: boolean;
  scanned: number;
  missingKind: number;
  coding: number;
  decision: number;
  codingByBenchmark: Record<string, number>;
  relationshipErrors: Array<{ id: string; reason: string }>;
};

export type AuditTableReport = {
  table: AuditTable;
  complete: boolean;
  pages: number;
  scanned: number;
  missingKind: number;
  coding: number;
  decision: number;
  codingByBenchmark: Record<string, number>;
  relationshipErrors: Array<{ id: string; reason: string }>;
};

export type AuditReport = {
  deployment: "dev" | "prod";
  pageSize: number;
  tables: Record<AuditTable, AuditTableReport>;
  safeToTighten: boolean;
};

export type AuditPageFetcher = (
  table: AuditTable,
  cursor: Cursor,
  pageSize: number,
  deployment: "dev" | "prod",
) => Promise<unknown>;

export type AuditOptions = {
  deployment?: "dev" | "prod";
  pageSize?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectInteger(value: unknown, name: string, minimum = 0): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum
  ) {
    throw new Error(`${name} must be a safe integer >= ${minimum}`);
  }
  return value;
}

function parseAuditPage(value: unknown, table: AuditTable): AuditPage {
  if (!isRecord(value)) throw new Error("Audit query returned a non-object");
  if (value.table !== table)
    throw new Error(
      `Audit query returned table ${JSON.stringify(value.table)} while auditing ${table}`,
    );
  if (typeof value.continueCursor !== "string")
    throw new Error("Audit query returned an invalid continueCursor");
  if (typeof value.isDone !== "boolean")
    throw new Error("Audit query returned an invalid isDone flag");

  const codingByBenchmark = value.codingByBenchmark;
  if (!isRecord(codingByBenchmark))
    throw new Error("Audit query returned invalid codingByBenchmark counts");
  const normalizedBenchmarks: Record<string, number> = {};
  for (const [benchmark, count] of Object.entries(codingByBenchmark)) {
    if (!benchmark)
      throw new Error("Audit query returned an empty benchmark key");
    normalizedBenchmarks[benchmark] = expectInteger(
      count,
      `codingByBenchmark[${benchmark}]`,
    );
  }

  if (!Array.isArray(value.relationshipErrors))
    throw new Error("Audit query returned invalid relationshipErrors");
  const relationshipErrors = value.relationshipErrors.map((error, index) => {
    if (
      !isRecord(error) ||
      typeof error.id !== "string" ||
      typeof error.reason !== "string"
    )
      throw new Error(
        `Audit query returned invalid relationship error at index ${index}`,
      );
    return { id: error.id, reason: error.reason };
  });

  const page: AuditPage = {
    table,
    continueCursor: value.continueCursor,
    isDone: value.isDone,
    scanned: expectInteger(value.scanned, "scanned"),
    missingKind: expectInteger(value.missingKind, "missingKind"),
    coding: expectInteger(value.coding, "coding"),
    decision: expectInteger(value.decision, "decision"),
    codingByBenchmark: normalizedBenchmarks,
    relationshipErrors,
  };
  if (page.coding + page.decision !== page.scanned)
    throw new Error(
      `Audit query counts for ${table} do not add up: coding + decision must equal scanned`,
    );
  if (!page.isDone && page.continueCursor.length === 0)
    throw new Error(
      `Audit query for ${table} returned an empty continuation cursor`,
    );
  return page;
}

function mergePage(report: AuditTableReport, page: AuditPage): void {
  report.pages += 1;
  report.scanned += page.scanned;
  report.missingKind += page.missingKind;
  report.coding += page.coding;
  report.decision += page.decision;
  for (const [benchmark, count] of Object.entries(page.codingByBenchmark)) {
    report.codingByBenchmark[benchmark] =
      (report.codingByBenchmark[benchmark] ?? 0) + count;
  }
  report.relationshipErrors.push(...page.relationshipErrors);
  report.complete = page.isDone;
}

export async function auditDocumentKinds(
  options: AuditOptions = {},
  fetchPage: AuditPageFetcher = runConvexAuditPage,
): Promise<AuditReport> {
  const deployment = options.deployment ?? "dev";
  const pageSize = options.pageSize ?? 100;
  expectInteger(pageSize, "pageSize", 1);
  if (pageSize > 100) throw new Error("pageSize must not exceed 100");

  const tables = Object.fromEntries(
    AUDIT_TABLES.map((table) => [
      table,
      {
        table,
        complete: false,
        pages: 0,
        scanned: 0,
        missingKind: 0,
        coding: 0,
        decision: 0,
        codingByBenchmark: {},
        relationshipErrors: [],
      } satisfies AuditTableReport,
    ]),
  ) as unknown as Record<AuditTable, AuditTableReport>;

  for (const table of AUDIT_TABLES) {
    let cursor: Cursor = null;
    const seenCursors = new Set<string>();
    for (;;) {
      const page = parseAuditPage(
        await fetchPage(table, cursor, pageSize, deployment),
        table,
      );
      mergePage(tables[table], page);
      if (page.isDone) break;
      if (
        seenCursors.has(page.continueCursor) ||
        page.continueCursor === cursor
      )
        throw new Error(
          `Audit query for ${table} repeated continuation cursor`,
        );
      seenCursors.add(page.continueCursor);
      cursor = page.continueCursor;
    }
  }

  const safeToTighten = AUDIT_TABLES.every((table) => {
    const report = tables[table];
    return (
      report.complete &&
      report.missingKind === 0 &&
      report.relationshipErrors.length === 0
    );
  });
  return { deployment, pageSize, tables, safeToTighten };
}

async function runConvexAuditPage(
  table: AuditTable,
  cursor: Cursor,
  pageSize: number,
  deployment: "dev" | "prod",
): Promise<unknown> {
  const projectRoot = join(import.meta.dir, "..");
  const args = JSON.stringify({
    table,
    paginationOpts: { cursor, numItems: pageSize },
  });
  const command = [
    process.execPath,
    "x",
    "convex",
    "run",
    "internal.migrations.auditDocumentKinds",
    args,
  ];
  if (deployment === "prod") command.push("--prod");
  const child = Bun.spawn(command, {
    cwd: join(projectRoot, "evalScores"),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    const detail = stderr.trim() || stdout.trim();
    throw new Error(
      `convex run audit failed with status ${exitCode}${detail ? `: ${detail}` : ""}`,
    );
  }
  const output = stdout.trim();
  if (!output) throw new Error("convex run audit returned no output");
  try {
    return JSON.parse(output) as unknown;
  } catch {
    throw new Error("convex run audit returned invalid JSON");
  }
}

export async function main(
  argv: string[] = process.argv.slice(2),
  fetchPage: AuditPageFetcher = runConvexAuditPage,
): Promise<number> {
  const unknown = argv.filter(
    (argument) => !["--prod", "--dev"].includes(argument),
  );
  if (unknown.length) throw new Error(`Unknown argument: ${unknown[0]}`);
  if (argv.includes("--prod") && argv.includes("--dev"))
    throw new Error("Choose either --prod or --dev");
  const report = await auditDocumentKinds(
    { deployment: argv.includes("--prod") ? "prod" : "dev" },
    fetchPage,
  );
  console.log(JSON.stringify(report, null, 2));
  return report.safeToTighten ? 0 : 1;
}

if (import.meta.main) {
  main().then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
