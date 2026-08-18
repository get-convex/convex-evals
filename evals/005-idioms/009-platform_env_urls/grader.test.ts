import { afterAll, expect, test } from "vitest";
import {
  adminKey,
  cloudUrl,
  compareFunctionSpec,
  getLatestOutputProjectDir,
  pollUntil,
  siteUrl,
} from "../../../grader";
import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const CATEGORY = "005-idioms";
const EVAL_NAME = "009-platform_env_urls";
const APP_NAME = "Whiteboard Live";

type DeploymentInfo = {
  siteUrl: string;
  cloudUrl: string;
  appName: string | null;
};

/** Set (value: string) or remove (value: null) a deployment env var through the backend's admin API. */
async function updateEnvVar(name: string, value: string | null) {
  const response = await fetch(`${cloudUrl}/api/update_environment_variables`, {
    method: "POST",
    headers: {
      Authorization: `Convex ${adminKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ changes: [{ name, value }] }),
  });
  if (!response.ok) {
    throw new Error(
      `update_environment_variables failed: ${response.status} ${await response.text()}`,
    );
  }
}

/** Each read is a fresh HTTP request: no client-side subscription cache to serve a stale value. */
async function getDeploymentInfo(): Promise<DeploymentInfo> {
  const client = new ConvexHttpClient(cloudUrl);
  return (await client.query(
    anyApi.deployment.getDeploymentInfo,
    {},
  )) as DeploymentInfo;
}

/** Env var updates commit before the admin endpoint responds, but poll briefly rather than assume. */
async function waitForAppName(expected: string | null): Promise<DeploymentInfo> {
  let latest: DeploymentInfo | null = null;
  await pollUntil(
    async () => {
      latest = await getDeploymentInfo();
      return latest.appName === expected;
    },
    { timeoutMs: 10_000, intervalMs: 250 },
  ).catch(() => undefined);
  return latest ?? (await getDeploymentInfo());
}

/** Compare every component of the URL, not just the port: scheme, loopback host, port, root path, no query/hash. */
function expectSameDeploymentUrl(actual: string, expected: string, label: string) {
  const a = new URL(actual);
  const e = new URL(expected);
  expect(a.protocol, `${label} protocol`).toBe(e.protocol);
  expect(
    ["localhost", "127.0.0.1"],
    `${label} host must be this deployment`,
  ).toContain(a.hostname);
  expect(a.port, `${label} port`).toBe(e.port);
  expect(a.pathname, `${label} must be the bare deployment URL`).toBe("/");
  expect(a.search, `${label} must have no query string`).toBe("");
  expect(a.hash, `${label} must have no fragment`).toBe("");
}

afterAll(async () => {
  await updateEnvVar("PUBLIC_APP_NAME", null);
});

test("compare function spec", async ({ skip }) => {
  await compareFunctionSpec(skip, { ignoreReturns: true, publicOnly: true });
});

test("returns this deployment's site and cloud URLs and null when the app name is unset", async () => {
  await updateEnvVar("PUBLIC_APP_NAME", null);
  const info = await waitForAppName(null);
  expectSameDeploymentUrl(info.siteUrl, siteUrl, "siteUrl");
  expectSameDeploymentUrl(info.cloudUrl, cloudUrl, "cloudUrl");
  expect(info.appName).toBeNull();
  expect(Object.keys(info).sort()).toEqual(["appName", "cloudUrl", "siteUrl"]);
});

test("returns the configured app name once PUBLIC_APP_NAME is set", async () => {
  await updateEnvVar("PUBLIC_APP_NAME", APP_NAME);
  try {
    const info = await waitForAppName(APP_NAME);
    expect(info.appName).toBe(APP_NAME);
    expectSameDeploymentUrl(info.siteUrl, siteUrl, "siteUrl");
  } finally {
    await updateEnvVar("PUBLIC_APP_NAME", null);
  }
  const reset = await waitForAppName(null);
  expect(reset.appName).toBeNull();
});

test("only PUBLIC_APP_NAME is declared: the generated env type has the platform URLs once and the app var as an optional string", () => {
  const generated = join(
    getLatestOutputProjectDir(CATEGORY, EVAL_NAME),
    "convex",
    "_generated",
    "server.d.ts",
  );
  expect(existsSync(generated), "convex/_generated/server.d.ts must exist").toBe(
    true,
  );
  const source = ts.createSourceFile(
    "server.d.ts",
    readFileSync(generated, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const members: { name: string; type: string }[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isTypeAliasDeclaration(node) &&
      node.name.text === "Env" &&
      ts.isTypeLiteralNode(node.type)
    ) {
      for (const member of node.type.members) {
        if (ts.isPropertySignature(member) && member.type !== undefined) {
          members.push({
            name: member.name.getText(),
            type: member.type.getText().replace(/\s+/g, " "),
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  const sorted = [...members].sort((a, b) => a.name.localeCompare(b.name));
  expect(
    sorted,
    "declare only PUBLIC_APP_NAME (optional string) in convex.config.ts; CONVEX_SITE_URL and CONVEX_CLOUD_URL are platform-provided and must not be redeclared",
  ).toEqual([
    { name: "CONVEX_CLOUD_URL", type: "string" },
    { name: "CONVEX_SITE_URL", type: "string" },
    { name: "PUBLIC_APP_NAME", type: "string | undefined" },
  ]);
});

test("getDeploymentInfo reads every value from the generated env object and nothing reads process.env", () => {
  const convexDir = join(
    getLatestOutputProjectDir(CATEGORY, EVAL_NAME),
    "convex",
  );
  const sources = collectSources(convexDir);

  // No authored source may touch `process` at all (process.env directly, via
  // globalThis, or through aliases like `const p = process` / `const e = process.env`).
  const processReads: string[] = [];
  for (const file of sources) {
    const visit = (node: ts.Node) => {
      const isProcessIdentifier =
        ts.isIdentifier(node) &&
        node.text === "process" &&
        !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) &&
        !(ts.isPropertyAssignment(node.parent) && node.parent.name === node) &&
        !ts.isImportSpecifier(node.parent);
      const isGlobalThisProcess =
        (ts.isPropertyAccessExpression(node) &&
          node.name.text === "process" &&
          node.expression.getText() === "globalThis") ||
        (ts.isElementAccessExpression(node) &&
          ts.isStringLiteral(node.argumentExpression) &&
          node.argumentExpression.text === "process");
      if (isProcessIdentifier || isGlobalThisProcess) {
        processReads.push(`${file.fileName}: ${node.parent.getText().slice(0, 60)}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  expect(processReads, "read environment variables through the typed env object, not process.env").toEqual([]);

  const deployment = sources.find((f) => f.fileName === "deployment.ts");
  expect(deployment, "convex/deployment.ts must exist").toBeDefined();
  const analysis = analyzeDeploymentModule(deployment!);
  expect(analysis.envAliases.size, "import `env` from ./_generated/server").toBeGreaterThan(0);
  expect(analysis.returned, "getDeploymentInfo must return an object").not.toBeNull();
  expect(analysis.siteUrl, "siteUrl must come from env.CONVEX_SITE_URL").toBe(true);
  expect(analysis.cloudUrl, "cloudUrl must come from env.CONVEX_CLOUD_URL").toBe(true);
  expect(analysis.appName, "appName must come from env.PUBLIC_APP_NAME").toBe(true);
});

// ── helpers ──────────────────────────────────────────────────────────

function collectSources(convexDir: string): ts.SourceFile[] {
  const files: ts.SourceFile[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === "_generated" || entry === "node_modules") continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
        files.push(
          ts.createSourceFile(
            relative(convexDir, full),
            readFileSync(full, "utf8"),
            ts.ScriptTarget.Latest,
            true,
            ts.ScriptKind.TS,
          ),
        );
      }
    }
  };
  walk(convexDir);
  return files;
}

function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

const isGeneratedServer = (specifier: string) =>
  /(^|\/)_generated\/server(\.js|\.ts)?$/.test(specifier);

/**
 * Anchor on getDeploymentInfo's handler and prove each returned property is
 * derived from the matching field of the `env` export of ./_generated/server.
 * Accepts `import { env }`, `import { env as e }`, `import * as server` +
 * `server.env.X`, destructuring `const { CONVEX_SITE_URL } = env`, and values
 * routed through same-module constants (with `??`, `as`, `satisfies`, etc.).
 */
function analyzeDeploymentModule(file: ts.SourceFile): {
  envAliases: Set<string>;
  returned: ts.ObjectLiteralExpression | null;
  siteUrl: boolean;
  cloudUrl: boolean;
  appName: boolean;
} {
  const envAliases = new Set<string>(); // identifiers bound to the env object
  const namespaceAliases = new Set<string>(); // `import * as server`
  const fieldAliases = new Map<string, string>(); // local name -> env field (destructuring)
  const constants = new Map<string, ts.Expression>();

  const collect = (node: ts.Node) => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      isGeneratedServer(node.moduleSpecifier.text) &&
      node.importClause?.namedBindings !== undefined
    ) {
      const named = node.importClause.namedBindings;
      if (ts.isNamespaceImport(named)) namespaceAliases.add(named.name.text);
      if (ts.isNamedImports(named)) {
        for (const element of named.elements) {
          if ((element.propertyName ?? element.name).text === "env") {
            envAliases.add(element.name.text);
          }
        }
      }
    }
    if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
      if (ts.isIdentifier(node.name)) {
        constants.set(node.name.text, node.initializer);
      }
    }
    ts.forEachChild(node, collect);
  };
  collect(file);

  // Second pass: aliases of env itself and destructured fields, now that imports are known.
  const isEnvObject = (expression: ts.Expression, seen = new Set<string>()): boolean => {
    const expr = unwrap(expression);
    if (ts.isIdentifier(expr)) {
      if (envAliases.has(expr.text)) return true;
      const init = constants.get(expr.text);
      if (init === undefined || seen.has(expr.text)) return false;
      seen.add(expr.text);
      return isEnvObject(init, seen);
    }
    if (
      ts.isPropertyAccessExpression(expr) &&
      expr.name.text === "env" &&
      ts.isIdentifier(expr.expression) &&
      namespaceAliases.has(expr.expression.text)
    ) {
      return true;
    }
    return false;
  };
  const collectDestructuring = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer !== undefined &&
      isEnvObject(node.initializer)
    ) {
      for (const element of node.name.elements) {
        if (ts.isIdentifier(element.name)) {
          const field = element.propertyName?.getText() ?? element.name.text;
          fieldAliases.set(element.name.text, field);
        }
      }
    }
    ts.forEachChild(node, collectDestructuring);
  };
  collectDestructuring(file);

  /** Does the expression (transitively) read env.<field>? */
  const readsEnvField = (
    expression: ts.Expression,
    field: string,
    seen = new Set<string>(),
  ): boolean => {
    let found = false;
    const scan = (node: ts.Node) => {
      if (found) return;
      if (
        ts.isPropertyAccessExpression(node) &&
        node.name.text === field &&
        isEnvObject(node.expression)
      ) {
        found = true;
        return;
      }
      if (
        ts.isElementAccessExpression(node) &&
        ts.isStringLiteral(node.argumentExpression) &&
        node.argumentExpression.text === field &&
        isEnvObject(node.expression)
      ) {
        found = true;
        return;
      }
      if (ts.isIdentifier(node)) {
        if (fieldAliases.get(node.text) === field) {
          found = true;
          return;
        }
        const init = constants.get(node.text);
        if (init !== undefined && !seen.has(node.text)) {
          seen.add(node.text);
          if (readsEnvField(init, field, seen)) {
            found = true;
            return;
          }
        }
      }
      ts.forEachChild(node, scan);
    };
    scan(unwrap(expression));
    return found;
  };

  // Locate getDeploymentInfo's handler and its returned object literal.
  const registration = constants.get("getDeploymentInfo");
  let returned: ts.ObjectLiteralExpression | null = null;
  if (registration !== undefined) {
    const call = unwrap(registration);
    if (ts.isCallExpression(call) && call.arguments.length > 0) {
      let config: ts.Expression = unwrap(call.arguments[0]);
      if (ts.isIdentifier(config) && constants.has(config.text)) {
        config = unwrap(constants.get(config.text)!);
      }
      if (ts.isObjectLiteralExpression(config)) {
        const handler = config.properties.find(
          (p) =>
            (ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p)) &&
            p.name !== undefined &&
            p.name.getText() === "handler",
        );
        const handlerShorthand = config.properties.find(
          (p) => ts.isShorthandPropertyAssignment(p) && p.name.text === "handler",
        );
        const body = handler !== undefined
          ? ts.isMethodDeclaration(handler)
            ? handler.body
            : ts.isPropertyAssignment(handler)
              ? unwrap(handler.initializer)
              : undefined
          : handlerShorthand !== undefined && constants.has("handler")
            ? unwrap(constants.get("handler")!)
            : undefined;
        const resolveReturned = (expression: ts.Expression, seen = new Set<string>()): ts.ObjectLiteralExpression | null => {
          const expr = unwrap(expression);
          if (ts.isObjectLiteralExpression(expr)) return expr;
          if (ts.isIdentifier(expr) && constants.has(expr.text) && !seen.has(expr.text)) {
            seen.add(expr.text);
            return resolveReturned(constants.get(expr.text)!, seen);
          }
          return null;
        };
        if (body !== undefined) {
          const visitReturns = (node: ts.Node) => {
            if (returned !== null) return;
            if (ts.isReturnStatement(node) && node.expression !== undefined) {
              returned = resolveReturned(node.expression);
              return;
            }
            // Arrow function with an expression body: `handler: async () => ({...})`
            if (
              ts.isArrowFunction(node) &&
              !ts.isBlock(node.body)
            ) {
              returned = resolveReturned(node.body);
              return;
            }
            ts.forEachChild(node, visitReturns);
          };
          if (ts.isArrowFunction(body) && !ts.isBlock(body.body)) {
            returned = resolveReturned(body.body);
          } else {
            visitReturns(body);
          }
        }
      }
    }
  }

  const property = (name: string): ts.Expression | null => {
    if (returned === null) return null;
    for (const p of (returned as ts.ObjectLiteralExpression).properties) {
      if (ts.isPropertyAssignment(p) && p.name.getText() === name) return p.initializer;
      if (ts.isShorthandPropertyAssignment(p) && p.name.text === name) return p.name;
    }
    return null;
  };
  const check = (name: string, field: string) => {
    const expr = property(name);
    return expr !== null && readsEnvField(expr, field);
  };
  return {
    envAliases: new Set([...envAliases, ...namespaceAliases]),
    returned,
    siteUrl: check("siteUrl", "CONVEX_SITE_URL"),
    cloudUrl: check("cloudUrl", "CONVEX_CLOUD_URL"),
    appName: check("appName", "PUBLIC_APP_NAME"),
  };
}
