import { expect, test } from "vitest";
import { getLatestOutputProjectDir } from "../../../grader/outputDir";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const CATEGORY = "007-components";
const EVAL_NAME = "005-choose_rate_limiter";

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

  for (const sourceFile of sources) {
    const clientCtors = new Set<string>();
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

    const clientVars = new Set<string>();
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

    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression)
      ) {
        const name = node.expression.name.text;
        const receiver = node.expression.expression;
        if (
          ts.isIdentifier(receiver) &&
          clientVars.has(receiver.text) &&
          ["limit", "check", "reset"].includes(name)
        ) {
          consumesLimit = consumesLimit || name === "limit";
        }
        // Direct component calls count as wiring too.
        if (
          (name === "runMutation" || name === "runQuery") &&
          node.arguments.length >= 1 &&
          node.arguments[0].getText().startsWith("components.rateLimiter.")
        ) {
          wiresComponent = true;
          if (name === "runMutation") consumesLimit = true;
        }
        // Hand-rolled fallback: scanning messages to count a time window.
        if (
          ["collect", "take", "filter", "paginate"].includes(name)
        ) {
          let current: ts.Expression = node;
          let queriesMessages = false;
          while (
            ts.isCallExpression(current) &&
            ts.isPropertyAccessExpression(current.expression)
          ) {
            const arg = current.arguments[0];
            if (
              current.expression.name.text === "query" &&
              arg !== undefined &&
              ts.isStringLiteralLike(arg) &&
              arg.text === "messages"
            ) {
              queriesMessages = true;
            }
            current = current.expression.expression;
          }
          if (queriesMessages) {
            windowScanConstructs.push(
              `${sourceFile.fileName}: messages .${name}() window scan`,
            );
          }
        }
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

test("consumes the limit in the send path", () => {
  expect(analysis.consumesLimit).toBe(true);
});

test("does not hand-roll a window by scanning messages", () => {
  expect(analysis.windowScanConstructs).toEqual([]);
});
