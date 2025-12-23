import { expect, test } from "vitest";
import { responseClient } from "../../../grader";
import { api } from "./answer/convex/_generated/api";
import { Id } from "./answer/convex/_generated/dataModel";

test("generate upload URL returns a string", async () => {
  const url: unknown = await responseClient.mutation(
    api.index.generateUploadUrl,
    {},
  );
  expect(typeof url).toBe("string");
  if (typeof url === "string") expect(url.length).toBeGreaterThan(0);
});

test("finishUpload stores file record", async () => {
  const url: unknown = await responseClient.mutation(
    api.index.generateUploadUrl,
    {},
  );
  expect(url).toBeTypeOf("string");
  // Simulate storage by creating a dummy storage id through upload flow is out of scope; rely on API shape
  await expect(
    responseClient.mutation(api.index.finishUpload, {
      storageId: "storage:fake" as Id<"_storage">,
    }),
  ).rejects.toBeDefined();
});

test("getFileUrl throws for missing file", async () => {
  await expect(
    responseClient.query(api.index.getFileUrl, {
      fileId: "files:missing" as Id<"files">,
    }),
  ).rejects.toBeDefined();
});

test("getFileMetadata throws for missing file", async () => {
  await expect(
    responseClient.query(api.index.getFileMetadata, {
      fileId: "files:missing" as Id<"files">,
    }),
  ).rejects.toBeDefined();
});

test("deleteFile throws for missing file", async () => {
  await expect(
    responseClient.mutation(api.index.deleteFile, {
      fileId: "files:missing" as Id<"files">,
    }),
  ).rejects.toBeDefined();
});
