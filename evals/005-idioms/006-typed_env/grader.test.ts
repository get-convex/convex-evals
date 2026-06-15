import { expect, test } from "vitest";
import { responseClient, readOutputFile } from "../../../grader";
import { makeFunctionReference } from "convex/server";
import ts from "typescript";

const getSupportConfig = makeFunctionReference<
  "query",
  Record<string, never>,
  {
    supportEmail: string | null;
    deploymentStage: "dev" | "preview" | "prod";
    isConfigured: boolean;
  }
>("config:getSupportConfig");

test("returns defaults when optional env vars are absent", async () => {
  const result = await responseClient.query(getSupportConfig, {});

  expect(result).toEqual({
    supportEmail: null,
    deploymentStage: "dev",
    isConfigured: false,
  });
});

test("declares typed env vars in convex.config.ts", () => {
  const source = readOutputFile(
    "005-idioms",
    "006-typed_env",
    "convex/convex.config.ts",
  );

  expect(source).toContain("defineApp");
  expect(source).toContain("SUPPORT_EMAIL");
  expect(source).toContain("DEPLOYMENT_STAGE");
  expect(source).toContain("v.optional(v.string())");
  expect(source).toContain('v.literal("dev")');
  expect(source).toContain('v.literal("preview")');
  expect(source).toContain('v.literal("prod")');
});

test("uses generated env object instead of process.env for app vars", () => {
  const source = readOutputFile(
    "005-idioms",
    "006-typed_env",
    "convex/config.ts",
  );

  expect(source).toContain("env");
  expect(source).toContain("SUPPORT_EMAIL");
  expect(source).toContain("DEPLOYMENT_STAGE");
  expect(source).not.toContain("process.env.SUPPORT_EMAIL");
  expect(source).not.toContain("process.env.DEPLOYMENT_STAGE");
});

test("returns configured values from typed env", () => {
  const source = readOutputFile(
    "005-idioms",
    "006-typed_env",
    "convex/config.ts",
  );
  const returned = resolveReturnedConfigFields(source);

  expect(returned.supportEmail).toBe(true);
  expect(returned.deploymentStage).toBe(true);
  expect(returned.isConfigured).toBe(true);
});

function resolveReturnedConfigFields(source: string): {
  supportEmail: boolean;
  deploymentStage: boolean;
  isConfigured: boolean;
} {
  const sourceFile = ts.createSourceFile(
    "convex/config.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const variables = new Map<string, ts.Expression>();
  let returnedObject: ts.ObjectLiteralExpression | null = null;

  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const initializer = node.initializer;
      if (initializer !== undefined) {
        variables.set(node.name.text, initializer);
      }
    }
    if (ts.isReturnStatement(node) && node.expression !== undefined) {
      const expression = unwrapExpression(node.expression);
      if (ts.isObjectLiteralExpression(expression)) {
        returnedObject = expression;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);

  if (returnedObject === null) {
    throw new Error("getSupportConfig must return an object literal");
  }

  return {
    supportEmail: propertyReferencesEnv(
      returnedObject,
      "supportEmail",
      "SUPPORT_EMAIL",
    ),
    deploymentStage: propertyReferencesEnv(
      returnedObject,
      "deploymentStage",
      "DEPLOYMENT_STAGE",
    ),
    isConfigured: propertyReferencesEnv(
      returnedObject,
      "isConfigured",
      "SUPPORT_EMAIL",
    ),
  };

  function propertyReferencesEnv(
    object: ts.ObjectLiteralExpression,
    propertyName: string,
    envName: string,
  ): boolean {
    const property = object.properties.find((candidate) => {
      if (ts.isShorthandPropertyAssignment(candidate)) {
        return candidate.name.text === propertyName;
      }
      if (!ts.isPropertyAssignment(candidate)) return false;
      return propertyNameFrom(candidate.name) === propertyName;
    });

    if (property === undefined) {
      throw new Error(`Missing returned property ${propertyName}`);
    }

    if (ts.isShorthandPropertyAssignment(property)) {
      return expressionReferencesEnv(property.name, envName);
    }
    if (ts.isPropertyAssignment(property)) {
      return expressionReferencesEnv(property.initializer, envName);
    }
    throw new Error(`Unsupported returned property ${propertyName}`);
  }

  function expressionReferencesEnv(
    expression: ts.Expression,
    envName: string,
    seen = new Set<string>(),
  ): boolean {
    const unwrapped = unwrapExpression(expression);
    if (ts.isIdentifier(unwrapped)) {
      return identifierReferencesEnv(unwrapped, envName, seen);
    }

    let found = false;
    function scan(node: ts.Node) {
      if (found) return;
      if (
        ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "env" &&
        node.name.text === envName
      ) {
        found = true;
        return;
      }
      if (ts.isIdentifier(node) && identifierReferencesEnv(node, envName, seen)) {
        found = true;
        return;
      }
      ts.forEachChild(node, scan);
    }
    scan(unwrapped);
    return found;
  }

  function identifierReferencesEnv(
    identifier: ts.Identifier,
    envName: string,
    seen: Set<string>,
  ): boolean {
    const initializer = variables.get(identifier.text);
    if (initializer === undefined || seen.has(identifier.text)) {
      return false;
    }
    seen.add(identifier.text);
    const referencesEnv = expressionReferencesEnv(initializer, envName, seen);
    seen.delete(identifier.text);
    return referencesEnv;
  }
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function propertyNameFrom(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) {
    return name.text;
  }
  return null;
}
