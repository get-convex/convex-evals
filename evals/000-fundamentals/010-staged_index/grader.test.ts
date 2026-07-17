import { expect, test } from "vitest";
import { compareSchema, getSchema, responseAdminClient } from "../../../grader";

test("compare schema", async ({ skip }) => {
  await compareSchema(skip);
});

test("the new index is STAGED and existing indexes are untouched", async () => {
  const schema = (await getSchema(responseAdminClient)) as {
    tables: {
      tableName: string;
      indexes?: { indexDescriptor: string; fields?: string[] }[];
      stagedDbIndexes?: { indexDescriptor: string; fields?: string[] }[];
    }[];
  } | null;
  expect(schema).not.toBeNull();
  const documents = schema!.tables.find((t) => t.tableName === "documents");
  expect(documents, "documents table must exist").toBeDefined();

  const staged = documents!.stagedDbIndexes ?? [];
  const stagedTarget = staged.find(
    (index) => index.indexDescriptor === "by_workspaceId_and_status",
  );
  expect(
    stagedTarget,
    "by_workspaceId_and_status must be declared with staged: true - a normal index blocks the deploy on a huge table",
  ).toBeDefined();
  // The backend appends the implicit _creationTime to serialized fields.
  expect(stagedTarget!.fields).toEqual([
    "workspaceId",
    "status",
    "_creationTime",
  ]);

  const active = documents!.indexes ?? [];
  expect(
    active.find(
      (index) => index.indexDescriptor === "by_workspaceId_and_status",
    ),
    "the new index must NOT be an ordinary (deploy-blocking) index",
  ).toBeUndefined();
  const existing = active.find(
    (index) => index.indexDescriptor === "by_workspaceId",
  );
  expect(existing, "the existing index must be preserved").toBeDefined();
});
