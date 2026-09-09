import { readFileSync } from "node:fs";

const answer = new URL(
  "../../evals/005-idioms/006-typed_env/answer/convex/",
  import.meta.url,
);
const reference = readFileSync(new URL("config.ts", answer), "utf8");
const app = readFileSync(new URL("convex.config.ts", answer), "utf8");
const fields = `{
  supportEmail: env.SUPPORT_EMAIL ?? null,
  deploymentStage: env.DEPLOYMENT_STAGE ?? "dev",
  isConfigured: env.SUPPORT_EMAIL !== undefined,
}`;
const defaults =
  '{ supportEmail: null, deploymentStage: "dev", isConfigured: false }';
const envType =
  '{ SUPPORT_EMAIL?: string; DEPLOYMENT_STAGE?: "dev" | "preview" | "prod" }';

function query(body: string, extra = ""): string {
  return `import { query, env } from "./_generated/server";
declare const process: { env: Record<string, string | undefined> };
${extra}
export const getSupportConfig = query({ args: {}, handler: async () => { ${body} } });`;
}

function fixture(
  name: string,
  valid: boolean,
  source: string,
  extra: Record<string, string> = {},
  probeValid = valid,
): {
  name: string;
  valid: boolean;
  probeValid: boolean;
  files: Record<string, string>;
} {
  return {
    name,
    valid,
    probeValid,
    files: {
      "convex/config.ts": source,
      "convex/convex.config.ts": app,
      ...extra,
    },
  };
}

export const typedEnvFixtures = [
  fixture("reference", true, reference),
  fixture("typescript-codegen", true, reference, {
    "convex.json": '{ "codegen": { "fileType": "ts" } }',
  }),
  fixture(
    "raw-typescript-codegen",
    false,
    query(`return ${fields.replaceAll("env.", "process.env.")};`),
    {
      "convex.json": '{ "codegen": { "fileType": "ts" } }',
    },
  ),
  fixture(
    "aliased-env",
    true,
    reference
      .replace("query, env", "query, env as settings")
      .replaceAll("env.", "settings."),
  ),
  fixture(
    "namespace-import",
    true,
    reference
      .replace(
        'import { query, env } from "./_generated/server";',
        'import * as server from "./_generated/server";',
      )
      .replace("query({", "server.query({")
      .replaceAll("env.", "server.env."),
  ),
  fixture(
    "destructuring-and-shorthand",
    true,
    query(`
    const { SUPPORT_EMAIL: supportEmail = null, DEPLOYMENT_STAGE: deploymentStage = "dev" } = env;
    return { supportEmail, deploymentStage, isConfigured: supportEmail !== null };`),
  ),
  fixture(
    "module-level-destructuring",
    true,
    query(
      `return ${fields.replaceAll("env.", "")};`,
      "const { SUPPORT_EMAIL, DEPLOYMENT_STAGE } = env;",
    ),
  ),
  fixture(
    "imported-helper",
    true,
    query("return readConfig();", 'import { readConfig } from "./helper";'),
    {
      "convex/helper.ts": `import { env } from "./_generated/server"; export function readConfig() { return ${fields}; }`,
    },
  ),
  fixture(
    "reexported-env",
    true,
    query(`return ${fields};`).replace(
      'import { query, env } from "./_generated/server";',
      'import { query } from "./_generated/server"; import { env } from "./helper";',
    ),
    {
      "convex/helper.ts": 'export { env } from "./_generated/server";',
    },
  ),
  fixture(
    "quoted-and-computed-properties",
    true,
    query(`return {
    "supportEmail": env[("SUPPORT_" + "EMAIL") as "SUPPORT_EMAIL"] ?? null,
    "deploymentStage": env["DEPLOYMENT_STAGE"] ?? "dev",
    "isConfigured": env["SUPPORT_EMAIL"] !== undefined,
  };`),
  ),
  fixture(
    "enumerated-env-loses-values",
    false,
    query(
      `const settings = { ...env }; return ${fields.replaceAll("env.", "settings.")};`,
    ),
  ),
  fixture(
    "explicit-typed-copy",
    true,
    query(`const settings = { SUPPORT_EMAIL: env.SUPPORT_EMAIL, DEPLOYMENT_STAGE: env.DEPLOYMENT_STAGE };
      return ${fields.replaceAll("env.", "settings.")};`),
  ),
  fixture(
    "unrelated-raw-variable",
    true,
    query(`void process.env.NODE_ENV; return ${fields};`),
  ),
  fixture(
    "uninvoked-raw-reader",
    true,
    query(
      `return ${fields};`,
      "function unused() { return process.env.SUPPORT_EMAIL; } void unused;",
    ),
  ),
  fixture(
    "local-process-name",
    true,
    query(
      `const process = { env: { SUPPORT_EMAIL: "unrelated" } }; void process.env.SUPPORT_EMAIL; return ${fields};`,
    ),
  ),
  fixture("aliased-validator-declarations", true, reference, {
    "convex/convex.config.ts": `import { defineApp as define } from "convex/server";
import { v as validators } from "convex/values";
const text = validators.string();
const stage = validators.union(validators.literal("prod"), validators.literal("dev"), validators.literal("preview"));
export default define({ env: { SUPPORT_EMAIL: validators.optional(text), DEPLOYMENT_STAGE: validators.optional(stage) } });`,
  }),
  fixture("imported-validator-declarations", true, reference, {
    "convex/convex.config.ts": `import { defineApp } from "convex/server";
import { declarations } from "./declarations";
export default defineApp({ env: declarations });`,
    "convex/declarations.ts": `import { v } from "convex/values";
export const declarations = { SUPPORT_EMAIL: v.optional(v.string()), DEPLOYMENT_STAGE: v.optional(v.union(v.literal("preview"), v.literal("prod"), v.literal("dev"))) };`,
  }),
  fixture(
    "membership-check-loses-values",
    false,
    query(`
    if (!("SUPPORT_EMAIL" in env) && !("DEPLOYMENT_STAGE" in env)) return ${defaults};
    return ${fields};`),
  ),
  fixture(
    "empty-config-shortcut",
    true,
    query(`if (env.SUPPORT_EMAIL === undefined && env.DEPLOYMENT_STAGE === undefined) return ${defaults};
      return ${fields};`),
  ),
  fixture(
    "fake-local-env",
    false,
    query(`return ${fields};`, `const env: ${envType} = {};`).replace(
      "{ query, env }",
      "{ query }",
    ),
  ),
  fixture("hardcoded-defaults", false, query(`return ${defaults};`)),
  fixture(
    "unused-typed-reads",
    false,
    query(
      `void env.SUPPORT_EMAIL; void env.DEPLOYMENT_STAGE; return ${defaults};`,
    ),
  ),
  fixture(
    "raw-direct",
    false,
    query(`return ${fields.replaceAll("env.", "process.env.")};`),
  ),
  fixture(
    "raw-alias-and-brackets",
    false,
    query(
      `const raw = process.env; return ${fields.replaceAll("env.SUPPORT_EMAIL", 'raw["SUPPORT_EMAIL"]').replaceAll("env.DEPLOYMENT_STAGE", 'raw["DEPLOYMENT_STAGE"]')};`,
    ),
  ),
  fixture(
    "raw-globalThis",
    false,
    query(`const raw = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env;
      return ${fields.replaceAll("env.", "raw.")};`),
  ),
  fixture(
    "raw-imported-helper",
    false,
    query("return readConfig();", 'import { readConfig } from "./helper";'),
    {
      "convex/helper.ts": `declare const process: { env: Record<string, string | undefined> };
export function readConfig() { return ${fields.replaceAll("env.", "process.env.")}; }`,
    },
  ),
  fixture(
    "raw-caught-with-typed-fallback",
    false,
    query(`try { void process.env.SUPPORT_EMAIL; } catch {} return ${fields};`),
  ),
  fixture(
    "raw-descriptor",
    false,
    query(
      `Object.getOwnPropertyDescriptor(process.env, "SUPPORT_EMAIL"); return ${fields};`,
    ),
  ),
  fixture(
    "empty-string-as-unset",
    false,
    query(
      `return ${fields.replace("env.SUPPORT_EMAIL ?? null", "env.SUPPORT_EMAIL || null").replace("env.SUPPORT_EMAIL !== undefined", "Boolean(env.SUPPORT_EMAIL)")};`,
    ),
  ),
  fixture(
    "stage-only-ignored",
    false,
    query(
      `if (env.SUPPORT_EMAIL === undefined) return ${defaults}; return ${fields};`,
    ),
  ),
  fixture(
    "stage-declared-as-string",
    false,
    reference,
    {
      "convex/convex.config.ts": `import { defineApp } from "convex/server"; import { v } from "convex/values";
export default defineApp({ env: { SUPPORT_EMAIL: v.optional(v.string()), DEPLOYMENT_STAGE: v.optional(v.string()) } });`,
    },
    true,
  ),
  fixture(
    "extra-stage-literal",
    false,
    reference,
    {
      "convex/convex.config.ts": app.replace(
        'v.literal("prod")',
        'v.literal("prod"), v.literal("staging")',
      ),
    },
    true,
  ),
  fixture(
    "missing-stage-literal",
    false,
    reference,
    {
      "convex/convex.config.ts": app.replace('v.literal("preview"), ', ""),
    },
    true,
  ),
  fixture(
    "missing-declarations",
    false,
    query(
      `return ${fields};`,
      `const env = generatedEnv as typeof generatedEnv & ${envType};`,
    ).replace("{ query, env }", "{ query, env as generatedEnv }"),
    {
      "convex/convex.config.ts":
        'import { defineApp } from "convex/server"; export default defineApp();',
    },
    true,
  ),
];
