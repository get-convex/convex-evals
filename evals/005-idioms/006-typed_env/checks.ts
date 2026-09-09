import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { inspectQuery } from "../../../grader/querySandbox";

export type AppEnv = {
  SUPPORT_EMAIL?: string;
  DEPLOYMENT_STAGE?: "dev" | "preview" | "prod";
};

export function supportConfigCases(token: string): AppEnv[] {
  return [
    {},
    {
      SUPPORT_EMAIL: `support-${token}@example.test`,
      DEPLOYMENT_STAGE: "preview",
    },
    {
      SUPPORT_EMAIL: `changed-${token}@example.test`,
      DEPLOYMENT_STAGE: "prod",
    },
    { SUPPORT_EMAIL: `dev-${token}@example.test`, DEPLOYMENT_STAGE: "dev" },
    { SUPPORT_EMAIL: "" },
    { DEPLOYMENT_STAGE: "prod" },
    { SUPPORT_EMAIL: `only-${token}@example.test` },
    {},
  ];
}

export function expectedSupportConfig(env: AppEnv): {
  supportEmail: string | null;
  deploymentStage: "dev" | "preview" | "prod";
  isConfigured: boolean;
} {
  return {
    supportEmail: env.SUPPORT_EMAIL ?? null,
    deploymentStage: env.DEPLOYMENT_STAGE ?? "dev",
    isConfigured: env.SUPPORT_EMAIL !== undefined,
  };
}

// Inspect SDK-generated metadata, not the spelling of the authored validators.
// The scorer regenerates this file from the deployed app's actual declarations.
export function declaredAppEnvTypes(
  projectDir: string,
): Record<string, string[]> {
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
    if (ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal))
      return [`literal:${node.literal.text}`];
    return ["unsupported"];
  }
  const result: Record<string, string[]> = {};
  for (const member of env.type.members) {
    if (
      ts.isPropertySignature(member) &&
      member.type &&
      (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name))
    ) {
      result[member.name.text] = [
        ...new Set([
          ...atoms(member.type),
          ...(member.questionToken ? ["undefined"] : []),
        ]),
      ].sort();
    }
  }
  return result;
}

export function inspectTypedAppEnv(
  projectDir: string,
  env: AppEnv,
): Promise<{
  result: ReturnType<typeof expectedSupportConfig>;
  reads: string[];
}> {
  return inspectQuery(
    projectDir,
    new URL("./inspect.mjs", import.meta.url),
    { env },
    {
      isolateTypedEnv: true,
    },
  );
}
