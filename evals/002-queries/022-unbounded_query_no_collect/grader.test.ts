import { expect, test, beforeEach } from "vitest";
import {
  addDocuments,
  compareFunctionSpec,
  compareSchema,
  deleteAllDocuments,
  responseAdminClient,
  responseClient,
  getLatestOutputProjectDir,
  listTable,
} from "../../../grader";
import { api } from "./answer/convex/_generated/api";
import { inspectBoundedQuery } from "./checks";

beforeEach(async () => {
  await deleteAllDocuments(responseAdminClient, ["auditLogs"]);
});

test("compare schema", async ({ skip }) => {
  await compareSchema(skip);
});

test("compare function spec", async ({ skip }) => {
  await compareFunctionSpec(skip, { ignoreReturns: true, publicOnly: true });
});

test("listAuditLogs returns an empty array for an empty workspace", async () => {
  const result = await responseClient.query(api.index.listAuditLogs, {
    workspaceId: "workspace-1",
  });

  expect(result).toEqual([]);
});

test("listAuditLogs returns stored entries for the requested workspace", async () => {
  // Put another workspace on both sides of the target in creation order.
  // Taking globally before filtering must not hide the requested workspace.
  await addDocuments(
    responseAdminClient,
    "auditLogs",
    ["workspace-before", "workspace-target", "workspace-after"].flatMap(
      (workspaceId) =>
        Array.from({ length: 205 }, (_, i) => ({
          workspaceId,
          actor: `${workspaceId}-actor-${i}`,
          action: `${workspaceId}-action-${i}`,
        })),
    ),
  );
  const stored = await listTable(responseAdminClient, "auditLogs", 615);
  expect(stored).toHaveLength(615);
  for (const workspaceId of [
    "workspace-target",
    "workspace-before",
    "workspace-after",
    "workspace-empty",
  ]) {
    const expected = stored.filter(
      (entry) => entry.workspaceId === workspaceId,
    );
    const result = await responseClient.query(api.index.listAuditLogs, {
      workspaceId,
    });
    expect(Array.isArray(result)).toBe(true);
    if (expected.length === 0) {
      expect(result).toEqual([]);
      continue;
    }
    // The task does not choose a limit or an order. Even take(1) is a valid
    // bounded default; completeness across pages belongs to separate evals.
    expect(result.length).toBeGreaterThan(0);
    expect(result.length).toBeLessThanOrEqual(expected.length);
    expect(new Set(result.map((entry) => entry._id)).size).toBe(result.length);
    for (const entry of result) {
      expect(entry).toEqual(
        expected.find((document) => document._id === entry._id),
      );
    }
  }
});

test("listAuditLogs includes system fields", async () => {
  await addDocuments(responseAdminClient, "auditLogs", [
    {
      workspaceId: "workspace-1",
      actor: "alice",
      action: "created project",
    },
  ]);

  const [result] = await responseClient.query(api.index.listAuditLogs, {
    workspaceId: "workspace-1",
  });

  expect(result._id).toBeDefined();
  expect(result._creationTime).toBeTypeOf("number");
});

test(
  "listAuditLogs consumes a bounded database query",
  { timeout: 15_000 },
  async () => {
    const projectDir = getLatestOutputProjectDir(
      "002-queries",
      "022-unbounded_query_no_collect",
    );
    await inspectBoundedQuery(projectDir);
  },
);
