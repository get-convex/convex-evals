import { expect, test, beforeEach } from "vitest";
import {
  addDocuments,
  compareFunctionSpec,
  compareSchema,
  deleteAllDocuments,
  responseAdminClient,
  responseClient,
  readOutputFile,
  containsCollectCall,
} from "../../../grader";
import { api } from "./answer/convex/_generated/api";

beforeEach(async () => {
  await deleteAllDocuments(responseAdminClient, ["auditLogs"]);
});

test("compare schema", async ({ skip }) => {
  await compareSchema(skip);
});

test("compare function spec", async ({ skip }) => {
  await compareFunctionSpec(skip, { ignoreReturns: true });
});

test("listAuditLogs returns an empty array for an empty workspace", async () => {
  const result = await responseClient.query(api.index.listAuditLogs, {
    workspaceId: "workspace-1",
  });

  expect(result).toEqual([]);
});

test("listAuditLogs filters to one workspace and orders newest first", async () => {
  await addDocuments(responseAdminClient, "auditLogs", [
    {
      workspaceId: "workspace-1",
      actor: "alice",
      action: "created project",
    },
    {
      workspaceId: "workspace-2",
      actor: "bob",
      action: "deleted file",
    },
    {
      workspaceId: "workspace-1",
      actor: "carol",
      action: "updated settings",
    },
    {
      workspaceId: "workspace-1",
      actor: "dave",
      action: "invited teammate",
    },
  ]);

  const result = await responseClient.query(api.index.listAuditLogs, {
    workspaceId: "workspace-1",
  });

  expect(result).toHaveLength(3);
  expect(result.map((entry) => entry.action)).toEqual([
    "invited teammate",
    "updated settings",
    "created project",
  ]);
  expect(result.every((entry) => entry.workspaceId === "workspace-1")).toBe(
    true,
  );
});

test("listAuditLogs returns at most 100 results", async () => {
  await addDocuments(
    responseAdminClient,
    "auditLogs",
    Array.from({ length: 105 }, (_, i) => ({
      workspaceId: "workspace-1",
      actor: `actor-${i}`,
      action: `action-${i}`,
    })),
  );

  const result = await responseClient.query(api.index.listAuditLogs, {
    workspaceId: "workspace-1",
  });

  expect(result).toHaveLength(100);
  expect(result[0].action).toBe("action-104");
  expect(result[99].action).toBe("action-5");
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

test("generated solution does not use collect in convex/index.ts", () => {
  // See README.md for why this eval treats `.collect()` as the wrong default
  // for a plain list-style query unless the task explicitly asks for the full set.
  const sourceText = readOutputFile(
    "002-queries",
    "022-unbounded_query_no_collect",
    "convex/index.ts",
  );
  expect(containsCollectCall(sourceText, "convex/index.ts")).toBe(false);
});
