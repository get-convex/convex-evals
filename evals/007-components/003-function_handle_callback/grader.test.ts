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
const EVAL_NAME = "003-function_handle_callback";

test("compare schema", async ({ skip }) => {
  await compareSchema(skip);
});

test("compare function spec", async ({ skip }) => {
  // Only runJob and getCompletionCount may be public; the callback stays
  // internal (an extra public function fails this compare).
  await compareFunctionSpec(skip, { ignoreReturns: true, publicOnly: true });
});

test(
  "each runJob invocation records exactly one completion via the callback",
  { timeout: 30_000 },
  async () => {
    const run = (jobKey: string) =>
      responseClient.mutation(anyApi.index.runJob, { jobKey });
    const countOf = (jobKey: string) =>
      responseClient.query(anyApi.index.getCompletionCount, { jobKey });

    expect(await countOf("job-a")).toBe(0);
    await run("job-a");
    expect(await countOf("job-a")).toBe(1);

    // Exactly once PER invocation - a double-calling component doubles this.
    await run("job-a");
    expect(await countOf("job-a")).toBe(2);

    await run("job-b");
    expect(await countOf("job-b")).toBe(1);
    expect(await countOf("job-a")).toBe(2);

    const completions = (await listTable(
      responseAdminClient,
      "completions",
      100,
    )) as { jobKey: string }[];
    expect(completions.map((c) => c.jobKey).sort()).toEqual([
      "job-a",
      "job-a",
      "job-b",
    ]);
  },
);

test("generated solution passes the callback across the boundary as a handle", () => {
  const projectDir = getLatestOutputProjectDir(CATEGORY, EVAL_NAME);
  const convexDir = join(projectDir, "convex");

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

  let definesComponent = false;
  let mountsLocalComponent = false;
  // In the app's runJob path: creates a handle, calls into the component,
  // and never writes completions itself (behavior cannot see this - a
  // direct insert is observationally identical).
  let runJobCreatesHandle = false;
  let runJobCallsComponent = false;
  let runJobInserts = false;
  // In the component: exactly one runMutation, not inside any loop.
  let componentRunMutationCount = 0;
  let componentRunMutationInLoop = false;

  const isInsideLoop = (node: ts.Node): boolean => {
    const iterationCallbacks = new Set(["map", "forEach", "flatMap"]);
    let current: ts.Node | undefined = node.parent;
    while (current !== undefined) {
      if (ts.isIterationStatement(current, false)) return true;
      if (
        ts.isCallExpression(current) &&
        ts.isPropertyAccessExpression(current.expression) &&
        iterationCallbacks.has(current.expression.name.text)
      ) {
        return true;
      }
      current = current.parent;
    }
    return false;
  };

  for (const { path, sourceFile } of sources) {
    const text = sourceFile.getFullText();
    const isComponentSource = path.includes("/");
    if (isComponentSource && /defineComponent\s*\(/.test(text)) {
      definesComponent = true;
    }
    if (
      path === "convex.config.ts" &&
      /from\s+["']\.\/.+\/convex\.config(?:\.js)?["']/.test(text) &&
      /\.use\(/.test(text)
    ) {
      mountsLocalComponent = true;
    }

    if (isComponentSource) {
      const visit = (node: ts.Node) => {
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === "runMutation"
        ) {
          componentRunMutationCount++;
          if (isInsideLoop(node)) componentRunMutationInLoop = true;
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
      continue;
    }

    // App sources: find runJob's handler and walk it.
    const visit = (node: ts.Node) => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === "runJob" &&
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
          const walk = (handlerNode: ts.Node) => {
            if (ts.isCallExpression(handlerNode)) {
              if (
                ts.isIdentifier(handlerNode.expression) &&
                handlerNode.expression.text === "createFunctionHandle"
              ) {
                runJobCreatesHandle = true;
              }
              if (
                ts.isPropertyAccessExpression(handlerNode.expression) &&
                handlerNode.expression.name.text === "runMutation" &&
                handlerNode.arguments.length >= 1 &&
                handlerNode.arguments[0].getText().startsWith("components.")
              ) {
                runJobCallsComponent = true;
              }
              if (
                ts.isPropertyAccessExpression(handlerNode.expression) &&
                handlerNode.expression.name.text === "insert"
              ) {
                runJobInserts = true;
              }
            }
            ts.forEachChild(handlerNode, walk);
          };
          walk(body);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  expect(definesComponent, "author jobRunner as a local component").toBe(true);
  expect(mountsLocalComponent, "mount the component from the root config").toBe(
    true,
  );
  expect(
    runJobCreatesHandle,
    "runJob must obtain the callback with createFunctionHandle",
  ).toBe(true);
  expect(
    runJobCallsComponent,
    "runJob must invoke the component's run mutation",
  ).toBe(true);
  expect(
    runJobInserts,
    "runJob must not write completions itself - only the callback does",
  ).toBe(false);
  expect(
    componentRunMutationCount,
    "the component must invoke the handle with ctx.runMutation exactly once",
  ).toBe(1);
  expect(componentRunMutationInLoop, "the handle call must not be looped").toBe(
    false,
  );
});

test("generated solution pins the required dependency", () => {
  const packageJson = JSON.parse(
    readOutputFile(CATEGORY, EVAL_NAME, "package.json"),
  );
  expect(packageJson.dependencies["convex"]).toBe("1.41.0");
});
