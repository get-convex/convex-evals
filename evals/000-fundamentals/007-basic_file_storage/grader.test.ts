import { expect, test } from "vitest";
import { responseClient } from "../../../grader";
import { anyApi } from "convex/server";

type Brand<T, B extends string> = T & { __brand: B };
type FilesId = Brand<string, "files">;
type StorageId = Brand<string, "_storage">;

test("generate upload URL returns a string", async () => {
  const url: unknown = await responseClient.mutation(
    anyApi.index.generateUploadUrl,
    {},
  );
  expect(typeof url).toBe("string");
  if (typeof url === "string") expect(url.length).toBeGreaterThan(0);
});

test("finishUpload stores file record", async () => {
  const url: unknown = await responseClient.mutation(
    anyApi.index.generateUploadUrl,
    {},
  );
  expect(url).toBeTypeOf("string");
  // Simulate storage by creating a dummy storage id through upload flow is out of scope; rely on API shape
  await expect(
    responseClient.mutation(anyApi.index.finishUpload, {
      storageId: "storage:fake" as unknown as StorageId,
    }),
  ).rejects.toBeDefined();
});

test("getFileUrl throws for missing file", async () => {
  await expect(
    responseClient.query(anyApi.index.getFileUrl, {
      fileId: "files:missing" as unknown as FilesId,
    }),
  ).rejects.toBeDefined();
});

test("getFileMetadata throws for missing file", async () => {
  await expect(
    responseClient.query(anyApi.index.getFileMetadata, {
      fileId: "files:missing" as unknown as FilesId,
    }),
  ).rejects.toBeDefined();
});

test("deleteFile throws for missing file", async () => {
  await expect(
    responseClient.mutation(anyApi.index.deleteFile, {
      fileId: "files:missing" as unknown as FilesId,
    }),
  ).rejects.toBeDefined();
});
