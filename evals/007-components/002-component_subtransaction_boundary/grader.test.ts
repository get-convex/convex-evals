import { expect, test } from "vitest";
import {
  compareFunctionSpec,
  compareSchema,
  getLatestOutputProjectDir,
  listTable,
  readOutputFile,
  responseAdminClient,
  responseClient,
} from "../../../grader";
import { anyApi } from "convex/server";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const CATEGORY = "007-components";
const EVAL_NAME = "002-component_subtransaction_boundary";

test("compare schema", async ({ skip }) => {
  // The component's audits table must NOT appear in the root schema - an
  // extra root table fails this compare, which is what forces a real
  // component boundary.
  await compareSchema(skip);
});

test("compare function spec", async ({ skip }) => {
  // Only recordAudit and getAuditCount may be client-visible; component
  // functions are internal references from the app's perspective.
  await compareFunctionSpec(skip, { ignoreReturns: true, publicOnly: true });
});

// One stateful scenario: component-owned audit rows cannot be reset through
// the root tables.
test(
  "component failure rolls back its write while the app commits",
  { timeout: 30_000 },
  async () => {
    const record = (event: string, shouldFail: boolean) =>
      responseClient.mutation(anyApi.index.recordAudit, { event, shouldFail });
    const countOf = (event: string) =>
      responseClient.query(anyApi.index.getAuditCount, { event });

    // Success path: audit row committed, success status recorded.
    expect(await record("ok", false)).toBe("audit_succeeded");
    expect(await countOf("ok")).toBe(1);

    // Failure path: recordAudit returns NORMALLY, the component's insert
    // (which ran before the throw) rolled back as a subtransaction, and
    // the app's own failure status still committed.
    expect(await record("boom", true)).toBe("audit_failed");
    expect(await countOf("boom")).toBe(0);

    // Audits accumulate on repeat successes, per event.
    expect(await record("ok", false)).toBe("audit_succeeded");
    expect(await countOf("ok")).toBe(2);

    // A previously failed event can succeed later.
    expect(await record("boom", false)).toBe("audit_succeeded");
    expect(await countOf("boom")).toBe(1);

    // The root table holds every status in order, both outcomes committed.
    const statuses = (await listTable(responseAdminClient, "auditStatuses", 100)) as {
      event: string;
      status: string;
    }[];
    expect(
      statuses.map((s) => `${s.event}:${s.status}`),
    ).toEqual([
      "ok:audit_succeeded",
      "boom:audit_failed",
      "ok:audit_succeeded",
      "boom:audit_succeeded",
    ]);
  },
);

test("generated solution authors a local component that inserts before throwing", () => {
  const projectDir = getLatestOutputProjectDir(CATEGORY, EVAL_NAME);
  const convexDir = join(projectDir, "convex");

  // Collect all authored sources under convex/ (skipping _generated).
  const sources: { path: string; sourceFile: ts.SourceFile }[] = [];
  const load = (relativeDir: string) => {
    for (const entry of readdirSync(join(convexDir, relativeDir), {
      withFileTypes: true,
    })) {
      const relativePath =
        relativeDir === "" ? entry.name : `${relativeDir}/${entry.name}`;
      if (entry.isDirectory() && entry.name !== "_generated") {
        load(relativePath);
      }
      if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
      const text = readOutputFile(CATEGORY, EVAL_NAME, `convex/${relativePath}`);
      sources.push({
        path: relativePath,
        sourceFile: ts.createSourceFile(
          relativePath,
          text,
          ts.ScriptTarget.Latest,
          true,
          ts.ScriptKind.TS,
        ),
      });
    }
  };
  load("");

  // A local component definition exists (in a subdirectory config).
  let definesComponent = false;
  // The root config mounts a local component config.
  let mountsLocalComponent = false;
  // writeAudit's handler inserts before any throw. Behavior cannot see
  // this: throw-before-insert also leaves zero rows on the failure path.
  let insertStep = -1;
  let throwStep = -1;

  for (const { path, sourceFile } of sources) {
    const text = sourceFile.getFullText();
    if (path.includes("/") && /defineComponent\s*\(/.test(text)) {
      definesComponent = true;
    }
    if (
      path === "convex.config.ts" &&
      /from\s+["']\.\/.+\/convex\.config(?:\.js)?["']/.test(text) &&
      /\.use\(/.test(text)
    ) {
      mountsLocalComponent = true;
    }

    // Find the writeAudit registration and walk its handler in order.
    const visit = (node: ts.Node) => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === "writeAudit" &&
        node.initializer !== undefined &&
        ts.isCallExpression(node.initializer) &&
        node.initializer.arguments.length >= 1 &&
        ts.isObjectLiteralExpression(node.initializer.arguments[0])
      ) {
        for (const property of node.initializer.arguments[0].properties) {
          const isHandler =
            property.name !== undefined &&
            ts.isIdentifier(property.name) &&
            property.name.text === "handler";
          const body = ts.isPropertyAssignment(property)
            ? property.initializer
            : ts.isMethodDeclaration(property)
              ? property.body
              : undefined;
          if (!isHandler || body === undefined) continue;
          let step = 0;
          const walkHandler = (handlerNode: ts.Node) => {
            if (
              ts.isCallExpression(handlerNode) &&
              ts.isPropertyAccessExpression(handlerNode.expression) &&
              handlerNode.expression.name.text === "insert"
            ) {
              step++;
              if (insertStep === -1) insertStep = step;
            }
            if (ts.isThrowStatement(handlerNode)) {
              step++;
              if (throwStep === -1) throwStep = step;
            }
            ts.forEachChild(handlerNode, walkHandler);
          };
          walkHandler(body);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  expect(
    definesComponent,
    "author the auditSink as a local component (defineComponent in its own directory)",
  ).toBe(true);
  expect(
    mountsLocalComponent,
    "mount the local component from the root convex.config.ts",
  ).toBe(true);
  expect(insertStep, "writeAudit must insert the audit row").toBeGreaterThan(-1);
  expect(throwStep, "writeAudit must throw when failAfterWrite is true").toBeGreaterThan(-1);
  expect(
    insertStep,
    "writeAudit must insert BEFORE throwing - the rollback is the concept under test",
  ).toBeLessThan(throwStep);
});
