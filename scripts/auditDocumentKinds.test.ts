import { describe, expect, it } from "bun:test";
import {
  auditDocumentKinds,
  main,
  type AuditPage,
  type AuditPageFetcher,
} from "./auditDocumentKinds";

function page(
  table: AuditPage["table"],
  cursor: string,
  isDone: boolean,
  overrides: Partial<AuditPage> = {},
): AuditPage {
  return {
    table,
    continueCursor: cursor,
    isDone,
    scanned: 2,
    missingKind: 0,
    coding: 2,
    decision: 0,
    codingByBenchmark: { "shared-version": 2 },
    relationshipErrors: [],
    ...overrides,
  };
}

describe("auditDocumentKinds", () => {
  it("consumes every page of every shared table and aggregates the audit", async () => {
    const calls: Array<[string, string | null, number, string]> = [];
    const fetchPage: AuditPageFetcher = async (
      table,
      cursor,
      pageSize,
      deployment,
    ) => {
      calls.push([table, cursor, pageSize, deployment]);
      if (cursor === null) return page(table, `${table}-next`, false);
      return page(table, "", true, {
        scanned: 1,
        coding: 0,
        decision: 1,
        codingByBenchmark: {},
      });
    };

    const report = await auditDocumentKinds(
      { deployment: "dev", pageSize: 50 },
      fetchPage,
    );

    expect(calls).toEqual([
      ["runs", null, 50, "dev"],
      ["runs", "runs-next", 50, "dev"],
      ["evals", null, 50, "dev"],
      ["evals", "evals-next", 50, "dev"],
      ["modelScores", null, 50, "dev"],
      ["modelScores", "modelScores-next", 50, "dev"],
    ]);
    expect(report.safeToTighten).toBe(true);
    expect(report.tables.runs).toMatchObject({
      complete: true,
      pages: 2,
      scanned: 3,
      coding: 2,
      decision: 1,
      missingKind: 0,
    });
  });

  it("keeps missing tags and relationship errors from declaring readiness", async () => {
    const fetchPage: AuditPageFetcher = async (table) =>
      page(table, "", true, {
        missingKind: table === "runs" ? 1 : 0,
        relationshipErrors:
          table === "evals"
            ? [{ id: "eval-1", reason: "Missing or opposite-kind parent run" }]
            : [],
      });

    const report = await auditDocumentKinds({}, fetchPage);
    expect(report.safeToTighten).toBe(false);
    expect(report.tables.runs.missingKind).toBe(1);
    expect(report.tables.evals.relationshipErrors).toHaveLength(1);
  });

  it("rejects a repeated continuation cursor instead of looping", async () => {
    const fetchPage: AuditPageFetcher = async (table) =>
      page(table, "same", false);
    await expect(auditDocumentKinds({}, fetchPage)).rejects.toThrow(
      "repeated continuation cursor",
    );
  });

  it("rejects invalid page output", async () => {
    const fetchPage: AuditPageFetcher = async () => ({
      table: "runs",
      continueCursor: "",
      isDone: true,
      scanned: 1,
      missingKind: 0,
      coding: 1,
      decision: 0,
      codingByBenchmark: null,
      relationshipErrors: [],
    });
    await expect(auditDocumentKinds({}, fetchPage)).rejects.toThrow(
      "invalid codingByBenchmark",
    );
  });

  it("returns a failing exit code for an audit that is complete but unsafe", async () => {
    const fetchPage: AuditPageFetcher = async (table) =>
      page(table, "", true, { missingKind: 1 });
    const code = await main(["--prod"], fetchPage);
    expect(code).toBe(1);
  });
});
