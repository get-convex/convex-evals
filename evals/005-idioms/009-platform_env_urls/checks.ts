import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { inspectQuery } from "../../../grader/querySandbox";

export type PlatformEnv = {
  CONVEX_SITE_URL: string;
  CONVEX_CLOUD_URL: string;
  PUBLIC_APP_NAME?: string;
};
export type DeploymentInfo = {
  siteUrl: string;
  cloudUrl: string;
  appName: string | null;
};

export function expectedDeploymentInfo(env: PlatformEnv): DeploymentInfo {
  return {
    siteUrl: env.CONVEX_SITE_URL,
    cloudUrl: env.CONVEX_CLOUD_URL,
    appName: env.PUBLIC_APP_NAME ?? null,
  };
}

export function platformEnvCases(token: string): PlatformEnv[] {
  const production = {
    CONVEX_SITE_URL: `https://deployment-${token}.convex.site`,
    CONVEX_CLOUD_URL: `https://deployment-${token}.convex.cloud`,
  };
  // Local ports cannot be derived by replacing a production hostname suffix.
  // Independent sentinels establish which supplied platform value is consumed.
  const local = {
    CONVEX_SITE_URL: "http://127.0.0.1:4713",
    CONVEX_CLOUD_URL: "http://localhost:8297",
  };
  return [
    production,
    { ...local, PUBLIC_APP_NAME: `App ${token}` },
    { ...production, PUBLIC_APP_NAME: `Changed ${token}` },
    { ...local, PUBLIC_APP_NAME: "" },
    local,
  ];
}

function normalizedUrl(value: string): string {
  const url = new URL(value);
  // Preserve equivalent loopback hosts and optional trailing slashes while
  // comparing every other URL component, including credentials and paths.
  if (url.hostname === "localhost") url.hostname = "127.0.0.1";
  return url.href;
}

export function deploymentInfoMatches(
  actual: DeploymentInfo,
  expected: DeploymentInfo,
): boolean {
  try {
    return (
      typeof actual.siteUrl === "string" &&
      typeof actual.cloudUrl === "string" &&
      actual.appName === expected.appName &&
      normalizedUrl(actual.siteUrl) === normalizedUrl(expected.siteUrl) &&
      normalizedUrl(actual.cloudUrl) === normalizedUrl(expected.cloudUrl)
    );
  } catch {
    return false;
  }
}

// Read SDK codegen, retaining duplicate properties so a redeclared platform
// variable cannot disappear into a name-keyed map. Accept both codegen formats.
export function generatedEnvMembers(
  projectDir: string,
): { name: string; types: string[] }[] {
  const path = ["server.d.ts", "server.ts"]
    .map((name) => join(projectDir, "convex/_generated", name))
    .find(existsSync);
  if (!path) throw new Error("Missing generated server types");
  const source = ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const env = source.statements.find(
    (node): node is ts.TypeAliasDeclaration =>
      ts.isTypeAliasDeclaration(node) && node.name.text === "Env",
  );
  if (!env || !ts.isTypeLiteralNode(env.type))
    throw new Error("Missing generated Env type");
  function atoms(node: ts.TypeNode): string[] {
    if (ts.isParenthesizedTypeNode(node)) return atoms(node.type);
    if (ts.isUnionTypeNode(node)) return node.types.flatMap(atoms);
    if (node.kind === ts.SyntaxKind.StringKeyword) return ["string"];
    if (node.kind === ts.SyntaxKind.UndefinedKeyword) return ["undefined"];
    return ["unsupported"];
  }
  return env.type.members
    .map((member) => {
      if (
        !ts.isPropertySignature(member) ||
        !member.type ||
        !(ts.isIdentifier(member.name) || ts.isStringLiteral(member.name))
      )
        throw new Error("Unsupported generated Env member");
      return {
        name: member.name.text,
        types: [
          ...new Set([
            ...atoms(member.type),
            ...(member.questionToken ? ["undefined"] : []),
          ]),
        ].sort(),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function inspectPlatformEnv(
  projectDir: string,
  env: PlatformEnv,
): Promise<{ result: DeploymentInfo; reads: string[] }> {
  return inspectQuery(
    projectDir,
    new URL("./inspect.mjs", import.meta.url),
    { env },
    { isolateTypedEnv: true },
  );
}
