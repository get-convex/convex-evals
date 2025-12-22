import { expect, test } from "vitest";
import {
  responseAdminClient,
  responseClient,
  compareSchema,
  deleteAllDocuments,
  listTable,
} from "../../../grader";
import { api } from "./answer/convex/_generated/api";
import { beforeEach } from "vitest";
import { createAIGraderTest } from "../../../grader/aiGrader";

createAIGraderTest(import.meta.url);
import { Doc } from "./answer/convex/_generated/dataModel";

beforeEach(async () => {
  await deleteAllDocuments(responseAdminClient, ["files"]);
});

test("compare schema", async ({ skip }) => {
  await compareSchema(skip);
});

test("successfully uploads file and stores metadata", async () => {
  const testContent = "Hello, World!";
  const fileName = "test.txt";

  const result = await responseClient.action(api.index.uploadFile, {
    contents: testContent,
    fileName,
  });

  // Check return value structure
  expect(result).toHaveProperty("fileId");
  expect(result).toHaveProperty("storageId");
  expect(result).toHaveProperty("url");
  expect(typeof result.url).toBe("string");
  expect(result.url).toMatch(/^https?:\/\//);

  // Verify file metadata in database
  const files = (await listTable(
    responseAdminClient,
    "files",
  )) as Doc<"files">[];
  const storedFile = files.find((f) => f._id === result.fileId);
  expect(storedFile).toBeDefined();
  expect(storedFile?.fileName).toBe(fileName);
  expect(storedFile?.storageId).toBe(result.storageId);
  expect(storedFile?.size).toBe(testContent.length);
});

test("handles empty file", async () => {
  const result = await responseClient.action(api.index.uploadFile, {
    contents: "",
    fileName: "empty.txt",
  });

  expect(result).toHaveProperty("fileId");
  expect(result).toHaveProperty("storageId");
  expect(result).toHaveProperty("url");

  const files = (await listTable(
    responseAdminClient,
    "files",
  )) as Doc<"files">[];
  const storedFile = files.find((f) => f._id === result.fileId);
  expect(storedFile?.size).toBe(0);
});

test("handles large file content", async () => {
  const largeContent = "x".repeat(1000000); // 1MB of content
  const result = await responseClient.action(api.index.uploadFile, {
    contents: largeContent,
    fileName: "large.txt",
  });

  expect(result).toHaveProperty("fileId");
  const files = (await listTable(
    responseAdminClient,
    "files",
  )) as Doc<"files">[];
  const storedFile = files.find((f) => f._id === result.fileId);
  expect(storedFile?.size).toBe(1000000);
});

test("handles special characters in filename", async () => {
  const fileName = "test file @#$%.txt";
  const result = await responseClient.action(api.index.uploadFile, {
    contents: "content",
    fileName,
  });

  const files = (await listTable(
    responseAdminClient,
    "files",
  )) as Doc<"files">[];
  const storedFile = files.find((f) => f._id === result.fileId);
  expect(storedFile?.fileName).toBe(fileName);
});

test("maintains consistent metadata", async () => {
  // Upload multiple files
  const files = [
    { contents: "file1", fileName: "file1.txt" },
    { contents: "file2", fileName: "file2.txt" },
    { contents: "file3", fileName: "file3.txt" },
  ];

  const results = await Promise.all(
    files.map(async (file) =>
      responseClient.action(api.index.uploadFile, file),
    ),
  );

  // Verify all metadata records
  const storedFiles = (await listTable(
    responseAdminClient,
    "files",
  )) as Doc<"files">[];
  expect(storedFiles).toHaveLength(files.length);

  for (let i = 0; i < files.length; i++) {
    const storedFile = storedFiles.find((f) => f._id === results[i].fileId);
    expect(storedFile?.fileName).toBe(files[i].fileName);
    expect(storedFile?.size).toBe(files[i].contents.length);
  }
});
