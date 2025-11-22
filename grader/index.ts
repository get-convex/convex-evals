import { ConvexClient } from "convex/browser";
import { expect } from "vitest";
/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/explicit-function-return-type */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-unsafe-argument */

const responsePortStr = process.env.CONVEX_PORT;
if (!responsePortStr) {
  throw new Error("CONVEX_PORT is not set");
}
const responsePort = Number(responsePortStr);

export const cloudUrl = `http://0.0.0.0:${responsePort}`;
export const siteUrl = `http://0.0.0.0:${responsePort + 1}`;

const answerPort = process.env.CONVEX_ANSWER_PORT;

export const responseClient = new ConvexClient(cloudUrl);

const adminKey =
  "0135d8598650f8f5cb0f30c34ec2e2bb62793bc28717c8eb6fb577996d50be5f4281b59181095065c5d0f86a2c31ddbe9b597ec62b47ded69782cd";
export const responseAdminClient = new ConvexClient(
  `http://0.0.0.0:${responsePort}`,
);
(responseAdminClient as any).setAdminAuth(adminKey);

let answerAdminClient: ConvexClient | null = null;
if (answerPort) {
  answerAdminClient = new ConvexClient(`http://0.0.0.0:${answerPort}`);
  (answerAdminClient as any).setAdminAuth(adminKey);
}

export async function getSchema(adminClient: any) {
  const result = await adminClient.query("_system/frontend/getSchemas" as any, {
    componentId: null,
  });
  if (!result.active) {
    return null;
  }
  const schema = JSON.parse(result.active);
  schema.tables.sort((a: any, b: any) =>
    a.tableName.localeCompare(b.tableName),
  );
  return schema;
}

/**
 * Insert the given documents into a table.
 */
export async function addDocuments(
  adminClient: any,
  table: string,
  documents: any[],
): Promise<void> {
  const result = await adminClient.mutation("_system/frontend/addDocument", {
    table,
    documents,
  });
  if (!result.success) {
    throw new Error(result.error);
  }
}

/**
 * List the given table, returning the results in ascending creation time order.
 */
export async function listTable(
  adminClient: any,
  table: string,
  limit: number = 32,
): Promise<any[]> {
  const result: any[] = await adminClient.query(
    "_system/frontend/listTableScan",
    {
      table,
      limit,
    },
  );
  result.reverse();
  return result;
}

export async function deleteAllDocuments(adminClient: any, tables: string[]) {
  const totalDeleted: Record<string, number> = {};
  for (const tableName of tables) {
    // We need to check if the table is empty before trying to delete it. It is possible for empty tables
    // to not have the `by_create_time` index, which will cause the `clearTablePage` mutation to fail.
    const docs = await listTable(responseAdminClient, tableName);
    if (docs.length > 0) {
      let { deleted, continueCursor, hasMore } = await adminClient.mutation(
        "_system/frontend/clearTablePage",
        { tableName, cursor: null },
      );
      totalDeleted[tableName] = deleted;
      while (hasMore) {
        ({ deleted, continueCursor, hasMore } = await adminClient.mutation(
          "_system/frontend/clearTablePage",
          { tableName, cursor: continueCursor },
        ));
        totalDeleted[tableName] += deleted;
      }
    }
  }
  return totalDeleted;
}

export async function compareSchema(skip: (note?: string) => void) {
  if (!answerAdminClient) {
    skip("Answer backend not available");
    return;
  }
  const responseSchema = await getSchema(responseAdminClient);
  const answerSchema = await getSchema(answerAdminClient);
  expect(responseSchema).toEqual(answerSchema);
}

async function getFunctionSpec(adminClient: any) {
  const result = await adminClient.query(
    "_system/cli/modules:apiSpec" as any,
    {},
  );
  return result;
}

export async function compareFunctionSpec(skip: (note?: string) => void) {
  if (!answerAdminClient) {
    skip("Answer backend not available");
    return;
  }
  const responseFunctionSpec = await getFunctionSpec(responseAdminClient);
  const answerFunctionSpec = await getFunctionSpec(answerAdminClient);
  expect(responseFunctionSpec).toEqual(answerFunctionSpec);
}

/**
 * Helpers for inspecting schema indexes in graders
 */
export function findTable(
  schema: any,
  tableName: string,
): {
  tableName: string;
  indexes?: { fields?: string[]; fieldNames?: string[] }[];
} | null {
  if (!schema || !Array.isArray(schema.tables)) return null;
  return schema.tables.find((t: any) => t.tableName === tableName) ?? null;
}

export function hasIndexForFields(
  schema: any,
  tableName: string,
  fields: string[],
): boolean {
  const table = findTable(schema, tableName);
  if (!table) return false;
  const indexes = (table.indexes ?? []) as {
    fields?: string[];
    fieldNames?: string[];
  }[];
  return indexes.some((idx) => {
    const idxFields = idx.fields ?? idx.fieldNames ?? [];
    return (
      Array.isArray(idxFields) &&
      idxFields.length === fields.length &&
      idxFields.every((f, i) => f === fields[i])
    );
  });
}

export async function hasIndexOn(
  schema: any,
  tableName: string,
  fields: string[],
): Promise<boolean> {
  return hasIndexForFields(schema, tableName, fields);
}

export function hasIndexForPrefix(
  schema: any,
  tableName: string,
  fieldsPrefix: string[],
): boolean {
  const table = findTable(schema, tableName);
  if (!table) return false;
  const indexes = (table.indexes ?? []) as {
    fields?: string[];
    fieldNames?: string[];
  }[];
  return indexes.some((idx) => {
    const idxFields = (idx.fields ?? idx.fieldNames ?? []);
    if (!Array.isArray(idxFields)) return false;
    if (idxFields.length < fieldsPrefix.length) return false;
    for (let i = 0; i < fieldsPrefix.length; i++) {
      if (idxFields[i] !== fieldsPrefix[i]) return false;
    }
    return true;
  });
}

export async function hasIndexWithPrefix(
  schema: any,
  tableName: string,
  fieldsPrefix: string[],
): Promise<boolean> {
  return hasIndexForPrefix(schema, tableName, fieldsPrefix);
}
