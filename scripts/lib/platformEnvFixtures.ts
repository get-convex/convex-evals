import { readFileSync } from "node:fs";

const answer = new URL(
  "../../evals/005-idioms/009-platform_env_urls/answer/convex/",
  import.meta.url,
);
const reference = readFileSync(new URL("deployment.ts", answer), "utf8");
const app = readFileSync(new URL("convex.config.ts", answer), "utf8");
const fields = `{ siteUrl: env.CONVEX_SITE_URL, cloudUrl: env.CONVEX_CLOUD_URL, appName: env.PUBLIC_APP_NAME ?? null }`;
function query(body: string, extra = ""): string {
  return `import { query, env } from "./_generated/server";
  declare const process: { env: Record<string, string | undefined> };
  ${extra}
  export const getDeploymentInfo = query({ args: {}, handler: async (ctx) => { ${body} } });`;
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
      "convex/deployment.ts": source,
      "convex/convex.config.ts": app,
      ...extra,
    },
  };
}

// These extra fields are valid Convex values even though ordinary JSON cannot
// represent them. They must survive both direct and nested query probe results.
const fieldsWithSpecialValues = `{ ...${fields}, tally: 1n, notANumber: NaN, negativeZero: -0, bytes: new Uint8Array([1, 2, 3]).buffer }`;

function nativeHelperFixtures(returnValue = fields, suffix = "") {
  return ["named", "snapshot", "handle"].flatMap((mode) =>
    (mode === "snapshot" ? ["typed"] : ["typed", "raw", "raw-caught"]).map(
      (access) => {
        const rawRead = "void process.env.PUBLIC_APP_NAME;";
        const beforeReturn =
          access === "typed"
            ? ""
            : access === "raw-caught"
              ? `try { ${rawRead} } catch {}`
              : rawRead;
        const target =
          mode === "handle"
            ? "await createFunctionHandle(internal.helper.readInfo)"
            : "internal.helper.readInfo";
        const options =
          mode === "snapshot" ? ", { useStaleSnapshot: true }" : "";
        const imports =
          'import { internal } from "./_generated/api";' +
          (mode === "handle"
            ? '\nimport { createFunctionHandle } from "convex/server";'
            : "");
        return fixture(
          `native-helper-${mode}-${access}${suffix}`,
          access === "typed" && mode !== "snapshot",
          query(
            `return await ctx.runQuery(${target}, {}${options});`,
            imports,
          ).replace(
            "async (ctx) =>",
            "async (ctx): Promise<{ siteUrl: string; cloudUrl: string; appName: string | null }> =>",
          ),
          {
            "convex/helper.ts": `import { env, internalQuery } from "./_generated/server";
declare const process: { env: Record<string, string | undefined> };
export const readInfo = internalQuery({ args: {}, handler: async () => {
  ${beforeReturn}
  return ${returnValue};
} });`,
          },
        );
      },
    ),
  );
}

export const platformEnvFixtures = [
  fixture(
    "optional-auth-read",
    true,
    query(`void await ctx.auth.getUserIdentity(); return ${fields};`).replace(
      "async (ctx) =>",
      "async (ctx) =>",
    ),
  ),
  fixture(
    "ordinary-native-db-read",
    true,
    query(
      `await ctx.db.query("envProbeNotes").take(1); return ${fields};`,
    ).replace("async (ctx) =>", "async (ctx) =>"),
  ),
  ...nativeHelperFixtures(),
  fixture(
    "additional-convex-special-values",
    true,
    query(`return ${fieldsWithSpecialValues};`),
  ),
  ...nativeHelperFixtures(fieldsWithSpecialValues, "-special-values").filter(
    (item) =>
      /(?:named-typed|handle-typed|handle-raw-caught)-special-values$/.test(
        item.name,
      ),
  ),
  fixture(
    "missing-required-export",
    false,
    reference.replace("getDeploymentInfo", "renamedInfo"),
  ),
  fixture(
    "array-wrapped-urls",
    false,
    query(
      `return { siteUrl: [env.CONVEX_SITE_URL], cloudUrl: [env.CONVEX_CLOUD_URL], appName: env.PUBLIC_APP_NAME ?? null };`,
    ),
  ),
  fixture("reference", true, reference),
  fixture(
    "additional-returned-field",
    true,
    query(`return { ...${fields}, label: "Deployment information" };`),
  ),
  fixture(
    "public-query-helper",
    true,
    `import { query } from "./_generated/server";
import { api } from "./_generated/api";
export const getDeploymentInfo = query({
  args: {},
  handler: async (ctx): Promise<{ siteUrl: string; cloudUrl: string; appName: string | null }> => ctx.runQuery(api.helper.readInfo, {}),
});`,
    { "convex/helper.ts": reference.replace("getDeploymentInfo", "readInfo") },
  ),
  // Keep valid query behavior while violating the required public API. These
  // exercise the API-spec check separately from the execution probe.
  fixture(
    "required-entrypoint-is-internal",
    false,
    reference.replace("env, query", "env, internalQuery as query"),
    { "convex/helper.ts": reference.replace("getDeploymentInfo", "readInfo") },
    true,
  ),
  fixture(
    "required-entrypoint-has-arguments",
    false,
    `import { v } from "convex/values";\n${reference.replace("args: {},", "args: { extra: v.string() },")}`,
    {},
    true,
  ),
  fixture(
    "native-url-origin",
    true,
    query(
      `return { siteUrl: new URL(env.CONVEX_SITE_URL).origin, cloudUrl: new URL(env.CONVEX_CLOUD_URL).origin, appName: env.PUBLIC_APP_NAME ?? null };`,
    ),
  ),
  fixture(
    "native-url-href",
    true,
    query(
      `return { siteUrl: new URL(env.CONVEX_SITE_URL).href, cloudUrl: new URL(env.CONVEX_CLOUD_URL).href, appName: env.PUBLIC_APP_NAME ?? null };`,
    ),
  ),
  fixture(
    "quoted-return-properties",
    true,
    query(
      `return { "siteUrl": env.CONVEX_SITE_URL, "cloudUrl": env.CONVEX_CLOUD_URL, "appName": env.PUBLIC_APP_NAME ?? null };`,
    ),
  ),
  fixture(
    "imported-helper",
    true,
    query("return readInfo();", 'import { readInfo } from "./helper";'),
    {
      "convex/helper.ts": `import { env } from "./_generated/server"; export function readInfo() { return ${fields}; }`,
    },
  ),
  fixture(
    "aliased-env",
    true,
    reference
      .replace("env, query", "env as settings, query")
      .replaceAll("env.", "settings."),
  ),
  fixture(
    "namespace-import",
    true,
    reference
      .replace(
        'import { env, query } from "./_generated/server";',
        'import * as server from "./_generated/server";',
      )
      .replace("query({", "server.query({")
      .replaceAll("env.", "server.env."),
  ),
  fixture(
    "destructuring-and-shorthand",
    true,
    query(
      `const { CONVEX_SITE_URL: siteUrl, CONVEX_CLOUD_URL: cloudUrl, PUBLIC_APP_NAME: appName = null } = env; return { siteUrl, cloudUrl, appName };`,
    ),
  ),
  fixture(
    "module-level-destructuring",
    true,
    query(
      `return ${fields.replaceAll("env.", "")};`,
      "const { CONVEX_SITE_URL, CONVEX_CLOUD_URL, PUBLIC_APP_NAME } = env;",
    ),
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
    "computed-properties",
    true,
    query(
      `return { ["site" + "Url"]: env["CONVEX_SITE_URL"], ["cloud" + "Url"]: env["CONVEX_CLOUD_URL"], appName: env["PUBLIC_APP_NAME"] ?? null };`,
    ),
  ),
  fixture(
    "internal-query-helper",
    true,
    query(
      "return await ctx.runQuery(internal.helper.readInfo, {});",
      'import { internal } from "./_generated/api";',
    ).replace(
      "async (ctx) =>",
      "async (ctx): Promise<{ siteUrl: string; cloudUrl: string; appName: string | null }> =>",
    ),
    {
      "convex/helper.ts": `import { env, internalQuery } from "./_generated/server"; export const readInfo = internalQuery({ args: {}, handler: async () => (${fields}) });`,
    },
  ),
  fixture("validator-alias", true, reference, {
    "convex/convex.config.ts":
      'import { defineApp as app } from "convex/server"; import { v as validators } from "convex/values"; const text = validators.string(); export default app({ env: { "PUBLIC_APP_NAME": validators.optional(text) } });',
  }),
  fixture("imported-validator", true, reference, {
    "convex/convex.config.ts":
      'import { defineApp } from "convex/server"; import { declarations } from "./declarations"; export default defineApp({ env: declarations });',
    "convex/declarations.ts":
      'import { v } from "convex/values"; export const declarations = { PUBLIC_APP_NAME: v.optional(v.string()) };',
  }),
  fixture("typescript-codegen", true, reference, {
    "convex.json": '{ "codegen": { "fileType": "ts" } }',
  }),
  fixture(
    "optional-return-validator",
    true,
    query(`return ${fields};`, 'import { v } from "convex/values";').replace(
      "args: {},",
      "args: {}, returns: v.object({ siteUrl: v.string(), cloudUrl: v.string(), appName: v.union(v.string(), v.null()) }),",
    ),
  ),
  fixture(
    "local-process-object",
    true,
    query(
      `const process = { env: { PUBLIC_APP_NAME: "irrelevant" } }; void process.env.PUBLIC_APP_NAME; return ${fields};`,
    ),
  ),
  fixture(
    "uninvoked-raw-reader",
    true,
    query(
      `return ${fields};`,
      "function unused() { return process.env.PUBLIC_APP_NAME; } void unused;",
    ),
  ),
  fixture(
    "equivalent-url-spelling",
    true,
    query(
      `return { siteUrl: env.CONVEX_SITE_URL.replace("127.0.0.1", "localhost") + "/", cloudUrl: env.CONVEX_CLOUD_URL + "/", appName: env.PUBLIC_APP_NAME ?? null };`,
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
      `const settings = process.env; return { siteUrl: settings["CONVEX_SITE_URL"], cloudUrl: settings["CONVEX_CLOUD_URL"], appName: settings["PUBLIC_APP_NAME"] ?? null };`,
    ),
  ),
  fixture(
    "raw-globalThis",
    false,
    query(
      `const raw = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env; return ${fields.replaceAll("env.", "raw.")};`,
    ),
  ),
  fixture(
    "raw-imported-helper",
    false,
    query("return readInfo();", 'import { readInfo } from "./helper";'),
    {
      "convex/helper.ts": `declare const process: { env: Record<string, string | undefined> }; export function readInfo() { return ${fields.replaceAll("env.", "process.env.")}; }`,
    },
  ),
  fixture(
    "raw-module-level",
    false,
    query(
      `return ${fields.replaceAll("env.", "")};`,
      "const { CONVEX_SITE_URL, CONVEX_CLOUD_URL, PUBLIC_APP_NAME } = process.env;",
    ),
  ),
  fixture(
    "raw-caught-with-typed-fallback",
    false,
    query(
      `try { void process.env.PUBLIC_APP_NAME; } catch {} return ${fields};`,
    ),
  ),
  fixture(
    "raw-unrelated-variable",
    false,
    query(`void process.env.NODE_ENV; return ${fields};`),
  ),
  fixture(
    "raw-descriptor-no-value",
    true,
    query(
      `Object.getOwnPropertyDescriptor(process.env, "CONVEX_SITE_URL"); return ${fields};`,
    ),
  ),
  fixture(
    "raw-membership-no-value",
    true,
    query(`void ("CONVEX_SITE_URL" in process.env); return ${fields};`),
  ),
  fixture(
    "raw-typescript-codegen",
    false,
    query(`return ${fields.replaceAll("env.", "process.env.")};`),
    { "convex.json": '{ "codegen": { "fileType": "ts" } }' },
  ),
  fixture(
    "swapped-urls",
    false,
    query(
      `return { siteUrl: env.CONVEX_CLOUD_URL, cloudUrl: env.CONVEX_SITE_URL, appName: env.PUBLIC_APP_NAME ?? null };`,
    ),
  ),
  fixture(
    "derive-site-from-cloud",
    false,
    query(
      `return { siteUrl: env.CONVEX_CLOUD_URL.replace(".convex.cloud", ".convex.site"), cloudUrl: env.CONVEX_CLOUD_URL, appName: env.PUBLIC_APP_NAME ?? null };`,
    ),
  ),
  fixture(
    "unused-typed-reads",
    false,
    query(
      `void env.CONVEX_SITE_URL; void env.CONVEX_CLOUD_URL; return { siteUrl: "https://fake.convex.site", cloudUrl: "https://fake.convex.cloud", appName: env.PUBLIC_APP_NAME ?? null };`,
    ),
  ),
  fixture(
    "fake-local-env",
    false,
    query(
      `return ${fields};`,
      'const env: { CONVEX_SITE_URL: string; CONVEX_CLOUD_URL: string; PUBLIC_APP_NAME?: string } = { CONVEX_SITE_URL: "https://fake.convex.site", CONVEX_CLOUD_URL: "https://fake.convex.cloud" };',
    ).replace("{ query, env }", "{ query }"),
  ),
  fixture(
    "empty-string-as-unset",
    false,
    query(
      `return ${fields.replace("env.PUBLIC_APP_NAME ?? null", "env.PUBLIC_APP_NAME || null")};`,
    ),
  ),
  fixture(
    "hardcoded-app-name",
    false,
    query(
      `return ${fields.replace("env.PUBLIC_APP_NAME ?? null", 'env.PUBLIC_APP_NAME === undefined ? null : "Whiteboard Live"')};`,
    ),
  ),
  fixture(
    "missing-declaration",
    false,
    query(
      `return ${fields};`,
      "const env = generatedEnv as typeof generatedEnv & { PUBLIC_APP_NAME?: string };",
    ).replace("{ query, env }", "{ query, env as generatedEnv }"),
    {
      "convex/convex.config.ts":
        'import { defineApp } from "convex/server"; export default defineApp();',
    },
    true,
  ),
  fixture(
    "extra-app-declaration",
    false,
    reference,
    {
      "convex/convex.config.ts":
        'import { defineApp } from "convex/server"; import { v } from "convex/values"; export default defineApp({ env: { PUBLIC_APP_NAME: v.optional(v.string()), EXTRA: v.optional(v.string()) } });',
    },
    true,
  ),
];
