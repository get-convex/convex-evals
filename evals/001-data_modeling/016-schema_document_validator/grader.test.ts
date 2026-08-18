import { beforeEach, expect, test } from "vitest";
import {
  addDocuments,
  compareFunctionSpec,
  compareSchema,
  deleteAllDocuments,
  getLatestOutputProjectDir,
  listTable,
  responseAdminClient,
  responseClient,
} from "../../../grader";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { anyApi } from "convex/server";
import ts from "typescript";

const CATEGORY = "001-data_modeling";
const EVAL_NAME = "016-schema_document_validator";

type Profile = {
  _id: string;
  _creationTime: number;
  displayName: string;
  bio: string;
};

beforeEach(async () => {
  await deleteAllDocuments(responseAdminClient, ["profiles"]);
});

async function seedProfile(): Promise<Profile> {
  await addDocuments(responseAdminClient, "profiles", [
    { displayName: "Ada", bio: "First bio" },
  ]);
  const profiles = (await listTable(
    responseAdminClient,
    "profiles",
    5,
  )) as Profile[];
  if (profiles.length !== 1) throw new Error("seed: profile was not stored");
  return profiles[0];
}

async function restore(snapshot: unknown): Promise<unknown> {
  return await responseClient.mutation(anyApi.profiles.restoreProfile, {
    snapshot,
  });
}

async function expectArgumentRejection(label: string, snapshot: unknown) {
  let error: unknown = null;
  try {
    await restore(snapshot);
  } catch (caught) {
    error = caught;
  }
  expect(
    error,
    `${label}: restoreProfile must reject this snapshot`,
  ).not.toBeNull();
  expect(
    String(error),
    `${label}: rejection must come from the argument validator`,
  ).toContain("ArgumentValidationError");
}

test("compare schema", async ({ skip }) => {
  await compareSchema(skip);
});

test("compare function spec", async ({ skip }) => {
  await compareFunctionSpec(skip, { ignoreReturns: true, publicOnly: true });
});

test("restoreProfile validates a complete stored profile document", async () => {
  const spec = (await responseAdminClient.query(
    "_system/cli/modules:apiSpec" as any,
    {},
  )) as { identifier: string; args?: unknown }[];
  const entry = spec.find(
    (candidate) => candidate.identifier === "profiles.js:restoreProfile",
  );
  expect(
    entry,
    "restoreProfile must exist in convex/profiles.ts",
  ).toBeDefined();

  let args = entry!.args as any;
  if (typeof args === "string") args = JSON.parse(args);
  const snapshot = args?.value?.snapshot;
  expect(snapshot, "restoreProfile must take `snapshot`").toBeDefined();
  expect(snapshot.optional).toBe(false);
  expect(snapshot.fieldType).toEqual({
    type: "object",
    value: {
      _id: {
        fieldType: { type: "id", tableName: "profiles" },
        optional: false,
      },
      _creationTime: {
        fieldType: { type: "number" },
        optional: false,
      },
      displayName: {
        fieldType: { type: "string" },
        optional: false,
      },
      bio: {
        fieldType: { type: "string" },
        optional: false,
      },
    },
  });
});

test("restoreProfile replaces the profile fields from a genuine snapshot", async () => {
  const profile = await seedProfile();
  const snapshot = {
    ...profile,
    displayName: "Ada Lovelace",
    bio: "Restored bio",
  };

  expect(await restore(snapshot)).toBeNull();
  const [after] = (await listTable(
    responseAdminClient,
    "profiles",
    5,
  )) as Profile[];
  expect(after).toEqual(snapshot);
});

test("restoreProfile rejects incomplete or invalid profile documents", async () => {
  const snapshot = await seedProfile();

  const { _creationTime: _time, ...withoutCreationTime } = snapshot;
  await expectArgumentRejection("missing _creationTime", withoutCreationTime);

  const { _id: _id, ...withoutId } = snapshot;
  await expectArgumentRejection("missing _id", withoutId);

  const { displayName: _name, ...withoutDisplayName } = snapshot;
  await expectArgumentRejection("missing displayName", withoutDisplayName);

  await expectArgumentRejection("wrong bio type", { ...snapshot, bio: 42 });
  await expectArgumentRejection("extra field", {
    ...snapshot,
    role: "admin",
  });
});

test("restoreProfile rejects a valid snapshot after its profile is deleted", async () => {
  const snapshot = await seedProfile();
  await deleteAllDocuments(responseAdminClient, ["profiles"]);
  await expect(restore(snapshot)).rejects.toThrow();
});

test("profile validators are declared only once, in schema.ts", () => {
  const convexDir = join(
    getLatestOutputProjectDir(CATEGORY, EVAL_NAME),
    "convex",
  );
  const declarations = new Map<string, string[]>([
    ["displayName", []],
    ["bio", []],
    ["_id", []],
    ["_creationTime", []],
  ]);

  for (const file of authoredTypeScriptFiles(convexDir)) {
    const source = ts.createSourceFile(
      file.relativePath,
      readFileSync(file.absolutePath, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const visit = (node: ts.Node) => {
      if (
        ts.isPropertyAssignment(node) &&
        (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
        declarations.has(node.name.text) &&
        ts.isCallExpression(node.initializer) &&
        node.initializer.expression.getText(source).startsWith("v.")
      ) {
        declarations
          .get(node.name.text)!
          .push(`${file.relativePath}: ${node.getText(source)}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  expect(declarations.get("displayName")).toHaveLength(1);
  expect(declarations.get("displayName")![0]).toMatch(/^schema\.ts:/);
  expect(declarations.get("bio")).toHaveLength(1);
  expect(declarations.get("bio")![0]).toMatch(/^schema\.ts:/);
  expect(declarations.get("_id")).toEqual([]);
  expect(declarations.get("_creationTime")).toEqual([]);
});

function authoredTypeScriptFiles(root: string): {
  absolutePath: string;
  relativePath: string;
}[] {
  const files: { absolutePath: string; relativePath: string }[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory)) {
      if (entry === "_generated" || entry === "node_modules") continue;
      const absolutePath = join(directory, entry);
      if (statSync(absolutePath).isDirectory()) {
        walk(absolutePath);
      } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
        files.push({
          absolutePath,
          relativePath: relative(root, absolutePath).replace(/\\/g, "/"),
        });
      }
    }
  };
  walk(root);
  return files;
}
