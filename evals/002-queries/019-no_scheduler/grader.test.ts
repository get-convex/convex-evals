import { expect, test } from "vitest";
import {
  responseAdminClient,
  responseClient,
  compareSchema,
  addDocuments,
  deleteAllDocuments,
  listTable,
} from "../../../grader";
import { api } from "./answer/convex/_generated/api";
import { beforeEach } from "vitest";
import { createAIGraderTest } from "../../../grader/aiGrader";

createAIGraderTest(import.meta.url);
import { Doc } from "./answer/convex/_generated/dataModel";

beforeEach(async () => {
  await deleteAllDocuments(responseAdminClient, ["documents", "accessLogs"]);
});

test("compare schema", async ({ skip }) => {
  await compareSchema(skip);
});

test("getDocument throws error for non-existent document", async () => {
  // Create a document first to get valid ID format
  await addDocuments(responseAdminClient, "documents", [
    { title: "Test", content: "Content" },
  ]);
  const docs = (await listTable(
    responseAdminClient,
    "documents",
  )) as Doc<"documents">[];
  const invalidId = docs[0]._id;

  // Delete the document
  await deleteAllDocuments(responseAdminClient, ["documents"]);

  await expect(
    responseClient.mutation(api.index.getDocument, {
      documentId: invalidId,
    }),
  ).rejects.toThrow("Document not found");
});

test("getDocument returns correct document data", async () => {
  const testDoc = {
    title: "Test Document",
    content: "Test Content",
  };

  await addDocuments(responseAdminClient, "documents", [testDoc]);
  const docs = (await listTable(
    responseAdminClient,
    "documents",
  )) as Doc<"documents">[];
  const docId = docs[0]._id;

  const result = await responseClient.mutation(api.index.getDocument, {
    documentId: docId,
  });

  expect(result).toMatchObject({
    _id: docId,
    ...testDoc,
  });
});

test("getDocument creates access log entry", async () => {
  // Create test document
  await addDocuments(responseAdminClient, "documents", [
    { title: "Test", content: "Content" },
  ]);
  const docs = (await listTable(
    responseAdminClient,
    "documents",
  )) as Doc<"documents">[];
  const docId = docs[0]._id;

  // Access document
  await responseClient.mutation(api.index.getDocument, {
    documentId: docId,
  });

  // Wait a short time for async operation
  await new Promise((resolve) => setTimeout(resolve, 100));

  // Check access logs
  const logs = (await listTable(
    responseAdminClient,
    "accessLogs",
  )) as Doc<"accessLogs">[];

  expect(logs).toHaveLength(1);
  expect(logs[0]).toMatchObject({
    documentId: docId,
    action: "read",
  });
});

test("getDocument creates multiple access logs for multiple accesses", async () => {
  // Create test document
  await addDocuments(responseAdminClient, "documents", [
    { title: "Test", content: "Content" },
  ]);
  const docs = (await listTable(
    responseAdminClient,
    "documents",
  )) as Doc<"documents">[];
  const docId = docs[0]._id;

  // Access document multiple times
  await Promise.all([
    responseClient.mutation(api.index.getDocument, { documentId: docId }),
    responseClient.mutation(api.index.getDocument, { documentId: docId }),
    responseClient.mutation(api.index.getDocument, { documentId: docId }),
  ]);

  // Wait a short time for async operations
  await new Promise((resolve) => setTimeout(resolve, 100));

  // Check access logs
  const logs = (await listTable(
    responseAdminClient,
    "accessLogs",
  )) as Doc<"accessLogs">[];

  expect(logs).toHaveLength(3);
  logs.forEach((log) => {
    expect(log).toMatchObject({
      documentId: docId,
      action: "read",
    });
  });
});

test("getDocument returns all required document fields", async () => {
  const testDoc = {
    title: "Test Document",
    content: "Test Content",
  };

  await addDocuments(responseAdminClient, "documents", [testDoc]);
  const docs = (await listTable(
    responseAdminClient,
    "documents",
  )) as Doc<"documents">[];
  const docId = docs[0]._id;

  const result = await responseClient.mutation(api.index.getDocument, {
    documentId: docId,
  });

  expect(result).toHaveProperty("_id");
  expect(result).toHaveProperty("_creationTime");
  expect(result).toHaveProperty("title");
  expect(result).toHaveProperty("content");
});

test("access logs are created with correct structure", async () => {
  await addDocuments(responseAdminClient, "documents", [
    { title: "Test", content: "Content" },
  ]);
  const docs = (await listTable(
    responseAdminClient,
    "documents",
  )) as Doc<"documents">[];
  const docId = docs[0]._id;

  await responseClient.mutation(api.index.getDocument, {
    documentId: docId,
  });

  // Wait a short time for async operation
  await new Promise((resolve) => setTimeout(resolve, 100));

  const logs = (await listTable(
    responseAdminClient,
    "accessLogs",
  )) as Doc<"accessLogs">[];

  expect(logs[0]).toHaveProperty("_id");
  expect(logs[0]).toHaveProperty("_creationTime");
  expect(logs[0]).toHaveProperty("documentId");
  expect(logs[0]).toHaveProperty("action");
});

test("getDocument handles concurrent access properly", async () => {
  // Create multiple test documents
  await addDocuments(responseAdminClient, "documents", [
    { title: "Doc 1", content: "Content 1" },
    { title: "Doc 2", content: "Content 2" },
  ]);
  const docs = (await listTable(
    responseAdminClient,
    "documents",
  )) as Doc<"documents">[];

  // Access different documents concurrently
  await Promise.all([
    responseClient.mutation(api.index.getDocument, { documentId: docs[0]._id }),
    responseClient.mutation(api.index.getDocument, { documentId: docs[1]._id }),
  ]);

  // Wait a short time for async operations
  await new Promise((resolve) => setTimeout(resolve, 100));

  const logs = (await listTable(
    responseAdminClient,
    "accessLogs",
  )) as Doc<"accessLogs">[];

  expect(logs).toHaveLength(2);
  expect(new Set(logs.map((log) => log.documentId))).toEqual(
    new Set([docs[0]._id, docs[1]._id]),
  );
});
