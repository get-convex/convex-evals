import { expect, test } from "vitest";
import { getLatestOutputProjectDir } from "../../../grader/outputDir";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const CATEGORY = "007-components";
const EVAL_NAME = "008-choose_rate_limiter_cooldown";

// SELECTION eval, static pipeline (see eval.json): measures whether the
// model CHOSE the rate-limiter component, tolerant of syntax/version/API
// noise. Invocation style is graded by the usage eval (001), not here.

interface Analysis {
  dependsOnRateLimiter: boolean;
  mountsRateLimiter: boolean;
  wiresComponent: boolean;
  consumesLimit: boolean;
  windowScanConstructs: string[];
}

function analyze(): Analysis {
  const projectDir = getLatestOutputProjectDir(CATEGORY, EVAL_NAME);

  let dependsOnRateLimiter = false;
  try {
    const packageJson = JSON.parse(
      readFileSync(join(projectDir, "package.json"), "utf-8"),
    ) as { dependencies?: Record<string, string> };
    dependsOnRateLimiter =
      packageJson.dependencies?.["@convex-dev/rate-limiter"] !== undefined;
  } catch {
    // Unparseable package.json: choice not visible.
  }

  const sources: ts.SourceFile[] = [];
  const load = (relativeDir: string) => {
    let entries;
    try {
      entries = readdirSync(join(projectDir, "convex", relativeDir), {
        withFileTypes: true,
      });
    } catch {
      return;
    }
    for (const entry of entries) {
      const relativePath =
        relativeDir === "" ? entry.name : `${relativeDir}/${entry.name}`;
      if (entry.isDirectory() && entry.name !== "_generated") {
        load(relativePath);
      }
      if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
      const text = readFileSync(
        join(projectDir, "convex", relativePath),
        "utf-8",
      );
      sources.push(
        ts.createSourceFile(
          relativePath,
          text,
          ts.ScriptTarget.Latest,
          true,
          ts.ScriptKind.TS,
        ),
      );
    }
  };
  load("");

  let mountsRateLimiter = false;
  let wiresComponent = false;
  let consumesLimit = false;
  const windowScanConstructs: string[] = [];

  // Pass 1 (all files): client constructors, limiter vars, helper bodies -
  // collected globally so instances/helpers factored into other modules
  // still count (models legitimately split these out).
  const chainQueriesMessages = (call: ts.CallExpression): boolean => {
    let current: ts.Expression = call;
    while (
      ts.isCallExpression(current) &&
      ts.isPropertyAccessExpression(current.expression)
    ) {
      const arg = current.arguments[0];
      if (
        current.expression.name.text === "query" &&
        arg !== undefined &&
        ts.isStringLiteralLike(arg) &&
        arg.text === "otpRequests"
      ) {
        return true;
      }
      current = current.expression.expression;
    }
    return false;
  };

  const clientCtors = new Set<string>();
  const clientVars = new Set<string>();
  const localFunctions = new Map<string, ts.Node>();
  for (const sourceFile of sources) {
    for (const statement of sourceFile.statements) {
      if (
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier)
      ) {
        const spec = statement.moduleSpecifier.text;
        if (/^@convex-dev\/rate-limiter\/convex\.config(?:\.js)?$/.test(spec)) {
          mountsRateLimiter =
            mountsRateLimiter || /\.use\(/.test(sourceFile.getFullText());
        }
        if (spec === "@convex-dev/rate-limiter") {
          const bindings = statement.importClause?.namedBindings;
          if (bindings !== undefined && ts.isNamedImports(bindings)) {
            for (const element of bindings.elements) {
              clientCtors.add(element.name.text);
            }
          }
        }
      }
    }

    const unwrap = (expression: ts.Expression): ts.Expression => {
      let current = expression;
      while (
        ts.isParenthesizedExpression(current) ||
        ts.isAsExpression(current)
      ) {
        current = current.expression;
      }
      return current;
    };

    const collectVars = (node: ts.Node) => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer !== undefined
      ) {
        const initializer = unwrap(node.initializer);
        if (
          ts.isNewExpression(initializer) &&
          ts.isIdentifier(initializer.expression) &&
          clientCtors.has(initializer.expression.text)
        ) {
          const firstArg = initializer.arguments?.[0];
          if (
            firstArg !== undefined &&
            firstArg.getText().startsWith("components.")
          ) {
            wiresComponent = true;
            clientVars.add(node.name.text);
          }
        }
      }
      ts.forEachChild(node, collectVars);
    };
    collectVars(sourceFile);

        const collectFunctions = (node: ts.Node) => {
      if (
        ts.isFunctionDeclaration(node) &&
        node.name !== undefined &&
        node.body !== undefined
      ) {
        localFunctions.set(node.name.text, node.body);
      }
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer !== undefined &&
        (ts.isArrowFunction(node.initializer) ||
          ts.isFunctionExpression(node.initializer))
      ) {
        localFunctions.set(node.name.text, node.initializer.body ?? node.initializer);
      }
      ts.forEachChild(node, collectFunctions);
    };
    collectFunctions(sourceFile);
  }

  // Pass 2 (all files): handler walk and scan detection.
  for (const sourceFile of sources) {
    let sendMessageHandler: ts.Node | undefined;
    const findHandler = (node: ts.Node) => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === "requestCode" &&
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
          if (ts.isPropertyAssignment(property) && isHandler) {
            sendMessageHandler = property.initializer;
          }
          if (ts.isMethodDeclaration(property) && isHandler) {
            sendMessageHandler = property.body;
          }
        }
      }
      ts.forEachChild(node, findHandler);
    };
    findHandler(sourceFile);

    // Limit consumption only counts on the sendMessage call path.
    const walked = new Set<ts.Node>();
    const walkHandler = (node: ts.Node, depth: number) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression)
      ) {
        const name = node.expression.name.text;
        const receiver = node.expression.expression;
        if (
          ts.isIdentifier(receiver) &&
          clientVars.has(receiver.text) &&
          name === "limit"
        ) {
          consumesLimit = true;
        }
        if (
          name === "runMutation" &&
          node.arguments.length >= 1 &&
          node.arguments[0].getText().startsWith("components.rateLimiter.")
        ) {
          consumesLimit = true;
        }
      }
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        localFunctions.has(node.expression.text) &&
        depth < 4
      ) {
        const body = localFunctions.get(node.expression.text)!;
        if (!walked.has(body)) {
          walked.add(body);
          walkHandler(body, depth + 1);
          walked.delete(body);
        }
      }
      ts.forEachChild(node, (child) => walkHandler(child, depth));
    };
    if (sendMessageHandler !== undefined) {
      walkHandler(sendMessageHandler, 0);
    }

    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression)
      ) {
        const name = node.expression.name.text;
        // Direct component calls count as wiring anywhere in the file.
        if (
          (name === "runMutation" || name === "runQuery") &&
          node.arguments.length >= 1 &&
          node.arguments[0].getText().startsWith("components.rateLimiter.")
        ) {
          wiresComponent = true;
        }
        // Hand-rolled fallback: scanning messages to count a time window.
        if (
          ["collect", "take", "filter", "paginate"].includes(name) &&
          chainQueriesMessages(node)
        ) {
          windowScanConstructs.push(
            `${sourceFile.fileName}: otpRequests .${name}() window scan`,
          );
        }
      }
      if (
        ts.isForOfStatement(node) &&
        node.awaitModifier !== undefined &&
        ts.isCallExpression(node.expression) &&
        chainQueriesMessages(node.expression)
      ) {
        windowScanConstructs.push(
          `${sourceFile.fileName}: otpRequests for-await window scan`,
        );
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  return {
    dependsOnRateLimiter,
    mountsRateLimiter,
    wiresComponent,
    consumesLimit,
    windowScanConstructs,
  };
}

const analysis = analyze();

test("chooses the rate-limiter component as a dependency", () => {
  expect(analysis.dependsOnRateLimiter).toBe(true);
});

test("mounts the component in the app config", () => {
  expect(analysis.mountsRateLimiter).toBe(true);
});

test("wires the component (client class or direct calls)", () => {
  expect(analysis.wiresComponent).toBe(true);
});

test("consumes the cooldown in the request path", () => {
  expect(analysis.consumesLimit).toBe(true);
});

test("does not hand-roll the cooldown by scanning otpRequests", () => {
  expect(analysis.windowScanConstructs).toEqual([]);
});
