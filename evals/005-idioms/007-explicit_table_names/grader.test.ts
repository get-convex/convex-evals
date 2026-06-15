import { beforeEach, expect, test } from "vitest";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import {
  compareSchema,
  deleteAllDocuments,
  responseAdminClient,
  responseClient,
} from "../../../grader";
import { anyApi } from "convex/server";

beforeEach(async () => {
  await deleteAllDocuments(responseAdminClient, ["contacts"]);
});

test("compare schema", async ({ skip }) => {
  await compareSchema(skip);
});

test("create and get contact", async () => {
  const id = await responseClient.mutation(anyApi.contacts.create, {
    name: "Ada Lovelace",
    email: "ada@example.com",
  });

  const contact = await responseClient.query(anyApi.contacts.get, { id });
  expect(contact).toMatchObject({
    _id: id,
    name: "Ada Lovelace",
    email: "ada@example.com",
    archived: false,
  });
});

test("rename patches only the contact name", async () => {
  const id = await responseClient.mutation(anyApi.contacts.create, {
    name: "Old Name",
    email: "old@example.com",
  });

  await responseClient.mutation(anyApi.contacts.rename, {
    id,
    name: "New Name",
  });

  const contact = await responseClient.query(anyApi.contacts.get, { id });
  expect(contact).toMatchObject({
    name: "New Name",
    email: "old@example.com",
    archived: false,
  });
});

test("replaceContact replaces the full contact document", async () => {
  const id = await responseClient.mutation(anyApi.contacts.create, {
    name: "Grace Hopper",
    email: "grace@example.com",
  });

  await responseClient.mutation(anyApi.contacts.replaceContact, {
    id,
    name: "Rear Admiral Hopper",
    email: "hopper@example.com",
    archived: true,
  });

  const contact = await responseClient.query(anyApi.contacts.get, { id });
  expect(contact).toMatchObject({
    name: "Rear Admiral Hopper",
    email: "hopper@example.com",
    archived: true,
  });
});

test("remove deletes an existing contact and returns false for a missing contact", async () => {
  const id = await responseClient.mutation(anyApi.contacts.create, {
    name: "Katherine Johnson",
    email: "katherine@example.com",
  });

  await expect(
    responseClient.mutation(anyApi.contacts.remove, { id }),
  ).resolves.toBe(true);

  await expect(
    responseClient.query(anyApi.contacts.get, { id }),
  ).resolves.toBeNull();
  await expect(
    responseClient.mutation(anyApi.contacts.remove, { id }),
  ).resolves.toBe(false);
});

test("ID-based ctx.db methods use explicit table names", () => {
  const outputDir = process.env.MODEL_OUTPUT_DIR;
  if (!outputDir) {
    throw new Error("MODEL_OUTPUT_DIR not set");
  }

  const candidates = ["convex/contacts.ts", "convex/contacts.js"];
  const sourcePath = candidates
    .map((candidate) => join(outputDir, candidate))
    .find((candidate) => existsSync(candidate));

  if (!sourcePath) {
    throw new Error("Expected convex/contacts.ts or convex/contacts.js");
  }

  const source = readFileSync(sourcePath, "utf-8");

  for (const method of ["get", "patch", "replace", "delete"]) {
    expect(source).toMatch(
      new RegExp(String.raw`ctx\.db\.${method}\(\s*["']contacts["']\s*,`),
    );
    expect(source).not.toMatch(
      new RegExp(String.raw`ctx\.db\.${method}\(\s*(?!["']contacts["']\s*,)`),
    );
  }
});
