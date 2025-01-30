import { expect, test } from "vitest";
import {
  responseAdminClient,
  responseClient,
  compareSchema,
  compareFunctionSpec,
  deleteAllDocuments,
} from "../../../grader";
import { anyApi } from "convex/server";
import { beforeEach } from "vitest";

beforeEach(async () => {
  await deleteAllDocuments(responseAdminClient, ["documents"]);
});

test("compare schema", async ({ skip }) => {
  await compareSchema(skip);
});

test("compare function spec", async ({ skip }) => {
  await compareFunctionSpec(skip);
});

const sampleDocument = {
  metadata: {
    title: "Test Document",
    author: {
      name: "John Doe",
      contact: {
        email: "john@example.com",
        phone: "123-456-7890",
      },
    },
    tags: ["test", "sample"],
  },
  content: "Sample content",
};

test("create and get document", async () => {
  const docId = await responseClient.mutation(
    anyApi.index.createDocument,
    sampleDocument
  );
  expect(docId).toBeDefined();

  const fetchedDoc = await responseClient.query(anyApi.index.getDocument, {
    documentId: docId,
  });
  expect(fetchedDoc).toBeDefined();
  expect(fetchedDoc?.metadata).toEqual(sampleDocument.metadata);
  expect(fetchedDoc?.content).toEqual(sampleDocument.content);
});

test("patch document metadata", async () => {
  const docId = await responseClient.mutation(
    anyApi.index.createDocument,
    sampleDocument
  );

  const newMetadata = {
    title: "Updated Title",
    author: {
      name: "Jane Doe",
      contact: {
        email: "jane@example.com",
      },
    },
    tags: ["updated"],
  };

  await responseClient.mutation(anyApi.index.patchDocumentMetadata, {
    documentId: docId,
    metadata: newMetadata,
  });

  const updatedDoc = await responseClient.query(anyApi.index.getDocument, {
    documentId: docId,
  });
  expect(updatedDoc?.metadata).toEqual(newMetadata);
  expect(updatedDoc?.content).toEqual(sampleDocument.content);
});

test("patch author info", async () => {
  const docId = await responseClient.mutation(
    anyApi.index.createDocument,
    sampleDocument
  );

  const newAuthor = {
    name: "Jane Smith",
    contact: {
      email: "jane.smith@example.com",
      // Note that phone is not included in the new author object
    },
  };

  await responseClient.mutation(anyApi.index.patchAuthorInfo, {
    documentId: docId,
    author: newAuthor,
  });

  const updatedDoc = await responseClient.query(anyApi.index.getDocument, {
    documentId: docId,
  });
  expect(updatedDoc?.metadata.author).toEqual(newAuthor);
  expect(updatedDoc?.metadata.title).toEqual(sampleDocument.metadata.title);
  expect(updatedDoc?.metadata.tags).toEqual(sampleDocument.metadata.tags);
  expect(updatedDoc?.content).toEqual(sampleDocument.content);
});

test("get non-existent document returns null", async () => {
  const docId = await responseClient.mutation(
    anyApi.index.createDocument,
    sampleDocument
  );
  await responseClient.mutation(anyApi.index.patchDocumentMetadata, {
    documentId: docId,
    metadata: sampleDocument.metadata,
  });
  await deleteAllDocuments(responseAdminClient, ["documents"]);

  const result = await responseClient.query(anyApi.index.getDocument, {
    documentId: docId,
  });
  expect(result).toBeNull();
});

test("validation errors", async () => {
  // Missing required fields
  const invalidDoc = {
    metadata: {
      title: "Test",
      author: {
        name: "John",
        // Missing contact object
      },
      tags: [],
    },
    content: "Test",
  };

  await expect(
    responseClient.mutation(anyApi.index.createDocument, invalidDoc as any)
  ).rejects.toThrow();
});
