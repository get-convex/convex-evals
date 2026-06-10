import { expect, test, beforeEach } from "vitest";
import {
  addDocuments,
  compareSchema,
  deleteAllDocuments,
  responseAdminClient,
  responseClient,
  readOutputFile,
} from "../../../grader";
import { anyApi } from "convex/server";
import ts from "typescript";

beforeEach(async () => {
  await deleteAllDocuments(responseAdminClient, ["activityLog"]);
});

test("compare schema", async ({ skip }) => {
  await compareSchema(skip);
});

test("deleteActivityLogs removes entries for the given workspace", async () => {
  await addDocuments(responseAdminClient, "activityLog", [
    { workspaceId: "ws-1", action: "login" },
    { workspaceId: "ws-1", action: "upload" },
    { workspaceId: "ws-1", action: "logout" },
    { workspaceId: "ws-2", action: "login" },
    { workspaceId: "ws-2", action: "download" },
  ]);

  await responseClient.mutation(anyApi.index.deleteActivityLogs, {
    workspaceId: "ws-1",
  });

  // Small delay to allow any scheduled follow-ups to complete
  await new Promise((resolve) => setTimeout(resolve, 1000));

  const allDocs = await responseAdminClient.query(
    "_system/frontend/listTableScan" as any,
    { table: "activityLog", limit: 100 },
  );
  const ws1Docs = allDocs.filter((d: any) => d.workspaceId === "ws-1");
  const ws2Docs = allDocs.filter((d: any) => d.workspaceId === "ws-2");
  expect(ws1Docs).toHaveLength(0);
  expect(ws2Docs).toHaveLength(2);
});

test("deleteActivityLogs does nothing for a workspace with no entries", async () => {
  await addDocuments(responseAdminClient, "activityLog", [
    { workspaceId: "ws-2", action: "login" },
  ]);

  await responseClient.mutation(anyApi.index.deleteActivityLogs, {
    workspaceId: "ws-1",
  });

  const allDocs = await responseAdminClient.query(
    "_system/frontend/listTableScan" as any,
    { table: "activityLog", limit: 100 },
  );
  expect(allDocs).toHaveLength(1);
  expect(allDocs[0].workspaceId).toBe("ws-2");
});

function containsSchedulerCall(sourceText: string, fileName: string): boolean {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  let found = false;

  const visit = (node: ts.Node) => {
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === "runAfter"
    ) {
      const expr = node.expression;
      if (
        ts.isPropertyAccessExpression(expr) &&
        expr.name.text === "scheduler"
      ) {
        found = true;
        return;
      }
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === "runAt"
    ) {
      const expr = node.expression;
      if (
        ts.isPropertyAccessExpression(expr) &&
        expr.name.text === "scheduler"
      ) {
        found = true;
        return;
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return found;
}

test("generated solution uses ctx.scheduler to self-schedule for batch processing", () => {
  const sourceText = readOutputFile(
    "003-mutations",
    "007-batch_delete_self_schedule",
    "convex/index.ts",
  );
  expect(containsSchedulerCall(sourceText, "convex/index.ts")).toBe(true);
});
