import { build, type Loader } from "esbuild";
import { builtinModules } from "node:module";
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { jsonToConvex, type JSONValue } from "convex/values";
import { ADMIN_KEY } from "../runner/convexBackend";
import { failGraderInfrastructure } from "./infrastructure";
import ts from "typescript";

// Integration tests supply their own disposable backend. Scored evals use the
// candidate's already-running local backend, never a hosted deployment.
const probeBackendPort = new AsyncLocalStorage<number>();
export function withQueryProbeBackend<T>(port: number, run: () => T): T {
  return probeBackendPort.run(port, run);
}

// Only rewrite the SDK-generated export. Authored process.env reads keep using
// the guest process object, so an env inspector can distinguish the two paths.
function isolateGeneratedEnv(contents: string, path: string): string {
  const source = ts.createSourceFile(
    path,
    contents,
    ts.ScriptTarget.Latest,
    true,
  );
  for (const statement of source.statements) {
    if (
      !ts.isVariableStatement(statement) ||
      !statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    )
      continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === "env" &&
        declaration.initializer
      ) {
        return (
          contents.slice(0, declaration.initializer.getStart(source)) +
          "globalThis.__convexTypedEnv" +
          contents.slice(declaration.initializer.end)
        );
      }
    }
  }
  // An older SDK can legitimately generate no env export. Preserve that shape:
  // the env grader's metadata and provenance assertions judge the task failure.
  // Synthesizing an export or aborting the probe would both change the evidence.
  return contents;
}

function moduleFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory())
      return entry.name === "_generated" ? [] : moduleFiles(path);
    return /\.(ts|js)$/.test(entry.name) && !entry.name.endsWith(".d.ts")
      ? [path]
      : [];
  });
}

// inspectorUrl must point to a trusted grader module, never model output.
export async function inspectQuery<T>(
  projectDir: string,
  inspectorUrl: URL,
  input: unknown,
  options: { isolateTypedEnv?: boolean } = {},
): Promise<T> {
  let convexDir: string;
  let packageDir: string;
  let inspector: string;
  let guestErrors: string;
  let modules: string[];
  try {
    convexDir = realpathSync(join(projectDir, "convex"));
    packageDir = realpathSync(join(projectDir, "node_modules"));
    inspector = realpathSync(fileURLToPath(inspectorUrl));
    guestErrors = realpathSync(
      fileURLToPath(new URL("./probeErrors.mjs", import.meta.url)),
    );
    modules = moduleFiles(convexDir).map((path) => {
      const name = relative(convexDir, path)
        .split(sep)
        .join("/")
        .replace(/\.(ts|js)$/, "");
      // Module initialization is candidate execution too: it can itself loop or
      // exhaust memory before the exported function is called.
      return `${JSON.stringify(name)}: () => { markCandidateStart(); return import(${JSON.stringify(path)}); }`;
    });
  } catch (error) {
    failGraderInfrastructure(
      `Could not prepare query probe: ${String(error)}`,
      "probe_setup",
    );
  }
  const defines: Record<string, string> = options.isolateTypedEnv
    ? {}
    : { "process.env": "{}" };
  const trustedEntryPath = join(projectDir, `query-probe-${randomUUID()}.js`);
  let bundle;
  try {
    // Resolve value codecs from the candidate's SDK. invokeQuery/invokeMutation
    // return Convex-encoded JSON, not plain JSON values; inspectors decode that
    // boundary before returning values or re-encoding nested syscall replies.
    bundle = await build({
      stdin: {
        contents: `import { inspect } from ${JSON.stringify(inspector)};
import { ProbeUnsupportedError, ProbeCandidateError, unsupportedProbeErrors, setUnsupportedProbeReporter } from ${JSON.stringify(guestErrors)};
import { jsonToConvex, convexToJson } from "convex/values";
export default async (notifyCandidateStart, markUnsupported) => {
  let candidateStarted = false;
  const markCandidateStart = () => {
    candidateStarted = true;
    notifyCandidateStart();
  };
  setUnsupportedProbeReporter(markUnsupported);
  try {
    const value = await inspect({${modules.join(",")}}, ${JSON.stringify(input)}, { jsonToConvex, convexToJson });
    const unsupported = unsupportedProbeErrors();
    if (unsupported.length) return { kind: "unsupported", message: unsupported.join("; ") };
    return value === undefined ? { kind: "undefined" } : { kind: "value", value };
  } catch (error) {
    const unsupported = unsupportedProbeErrors();
    return {
      kind: unsupported.length || error instanceof ProbeUnsupportedError ? "unsupported"
        : candidateStarted || error instanceof ProbeCandidateError ? "candidateError" : "inspectorError",
      message: unsupported.length ? unsupported.join("; ") : String(error),
    };
  }
};`,
        resolveDir: projectDir,
        sourcefile: trustedEntryPath,
      },
      bundle: true,
      write: false,
      format: "iife",
      globalName: "probeBundle",
      platform: "neutral",
      mainFields: ["module", "main"],
      conditions: ["import"],
      // Default to an empty guest environment. Env inspectors install their own
      // tracked guest objects; neither mode exposes host process or credentials.
      define: defines,
      target: "es2022",
      logLevel: "silent",
      // External host modules have no loader inside a Convex query. They are never
      // imported or executed by Node, including in otherwise-unused modules.
      external: [...builtinModules, "node:*"],
      plugins: [
        {
          name: "restrict-probe-inputs",
          setup(builder) {
            const resolving = {};
            builder.onResolve({ filter: /.*/ }, async (args) => {
              if (args.pluginData === resolving) return;
              const resolution = await builder.resolve(args.path, {
                importer: args.importer,
                namespace: args.namespace,
                resolveDir: args.resolveDir,
                kind: args.kind,
                pluginData: resolving,
              });
              if (
                resolution.errors.length === 0 &&
                !resolution.external &&
                realpathSync(resolution.path) === guestErrors &&
                args.importer !== inspector &&
                args.importer !== trustedEntryPath
              ) {
                return {
                  errors: [
                    {
                      text: "Only the trusted query inspector may import probe error controls",
                    },
                  ],
                };
              }
              // The recursion guard is only for builder.resolve above. Do not
              // pass it on to the resolved module's own import edges.
              return { ...resolution, pluginData: undefined };
            });
            builder.onLoad({ filter: /.*/ }, (args) => {
              const path = realpathSync(args.path);
              const allowed =
                path === inspector ||
                path === guestErrors ||
                [convexDir, packageDir].some((root) =>
                  path.startsWith(root + sep),
                );
              if (!allowed)
                throw new Error(
                  "Probe import is outside the generated source and dependencies",
                );
              const extension = extname(path).slice(1);
              const loader =
                extension === "mjs" || extension === "cjs" ? "js" : extension;
              if (!["js", "ts", "tsx", "jsx", "json"].includes(loader))
                throw new Error("Unsupported probe import type");
              const contents = readFileSync(path, "utf8");
              const isGeneratedServer = ["server.js", "server.ts"].some(
                (name) => path === join(convexDir, "_generated", name),
              );
              return {
                contents:
                  options.isolateTypedEnv && isGeneratedServer
                    ? isolateGeneratedEnv(contents, path)
                    : contents,
                loader: loader as Loader,
              };
            });
          },
        },
      ],
    });
  } catch (error) {
    failGraderInfrastructure(
      `Could not bundle query probe: ${String(error)}`,
      "probe_bundle",
    );
  }

  const port = probeBackendPort.getStore() ?? Number(process.env.CONVEX_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    failGraderInfrastructure(
      "Query probe requires a running local Convex backend",
      "probe_backend",
    );

  // The one-off endpoint uses Convex's own V8 runtime in an uncommitted
  // transaction. Writes and scheduler effects do not persist. Native platform
  // APIs remain available without exposing Node, host files, or credentials.
  // The query wrapper prevents network fetches and nested mutation calls.
  const startMarker = `convex-query-probe-start:${randomUUID()}`;
  const completeMarker = `convex-query-probe-complete:${randomUUID()}`;
  const unsupportedMarker = `convex-query-probe-unsupported:${randomUUID()}`;
  // Native logs survive Convex's uncatchable timeout and memory-limit errors.
  // Capture the logger before candidate code can change console. Independent
  // tokens prevent an ordinary candidate message from supplying provenance.
  const source = `import { query } from "convex:/_system/repl/wrappers.js";
export default query({ handler: async () => {
  const nativeLog = console.log.bind(console);
  let candidateStarted = false;
  const markCandidateStart = () => {
    if (!candidateStarted) {
      candidateStarted = true;
      nativeLog(${JSON.stringify(startMarker)});
    }
  };
  let unsupportedReported = false;
  const markUnsupported = () => {
    if (!unsupportedReported) {
      unsupportedReported = true;
      nativeLog(${JSON.stringify(unsupportedMarker)});
    }
  };
  globalThis.process = { env: {} };
  ${bundle.outputFiles[0].text}
  const result = await probeBundle.default(markCandidateStart, markUnsupported);
  nativeLog(${JSON.stringify(completeMarker)});
  return result;
} });`;
  let response;
  let payload: unknown;
  try {
    response = await fetch(`http://localhost:${port}/api/run_test_function`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        adminKey: ADMIN_KEY,
        args: {},
        bundle: { path: "testQuery.js", source },
        format: "convex_encoded_json",
      }),
      signal: AbortSignal.timeout(10_000),
    });
    payload = await response.json();
  } catch (error) {
    failGraderInfrastructure(
      `Query probe transport failed: ${String(error)}`,
      "probe_transport",
    );
  }
  if (!response.ok)
    failGraderInfrastructure(
      `Convex query probe could not complete (${response.status}): ${JSON.stringify(payload)}`,
      "probe_execution",
    );
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload) ||
    !("status" in payload)
  )
    failGraderInfrastructure("Invalid query probe protocol", "probe_response");
  const logLines = "logLines" in payload ? payload.logLines : [];
  if (
    !Array.isArray(logLines) ||
    !logLines.every((line) => typeof line === "string")
  )
    failGraderInfrastructure("Invalid query probe logs", "probe_response");
  if (payload.status === "error") {
    if (
      !("errorMessage" in payload) ||
      typeof payload.errorMessage !== "string"
    )
      failGraderInfrastructure("Invalid query probe error", "probe_response");
    if (logLines.includes(`[LOG] '${unsupportedMarker}'`))
      failGraderInfrastructure(
        `An unsupported probe path preceded the execution failure: ${payload.errorMessage}`,
        "probe_unsupported",
      );
    // The backend retains the first logs and replaces the final slot with this
    // native overflow record. A missing completion marker is then ambiguous:
    // candidate execution and later result encoding can both have failed.
    if (
      logLines.includes(
        "[ERROR] Log overflow (maximum 256). Remaining log lines omitted.",
      )
    )
      failGraderInfrastructure(
        `Query probe logs were truncated; execution phase cannot be determined: ${payload.errorMessage}`,
        "probe_provenance",
      );
    const started = logLines.includes(`[LOG] '${startMarker}'`);
    const completed = logLines.includes(`[LOG] '${completeMarker}'`);
    if (started && !completed)
      throw new Error(
        `Query probe failed during candidate execution: ${payload.errorMessage}`,
      );
    // HTTP 200 only establishes an application error. A trusted prelude can
    // fail before candidate import, and Convex can reject the completed probe's
    // result during encoding. Neither is evidence of a candidate resource bug.
    failGraderInfrastructure(
      `Query probe failed ${completed ? "after producing its result" : "before candidate execution"}: ${payload.errorMessage}`,
      "probe_execution",
    );
  }
  if (payload.status !== "success" || !("value" in payload))
    failGraderInfrastructure("Invalid query probe protocol", "probe_response");

  let decoded;
  try {
    decoded = jsonToConvex(payload.value as JSONValue);
  } catch (error) {
    failGraderInfrastructure(
      `Invalid query probe encoding: ${String(error)}`,
      "probe_response",
    );
  }
  const result = decoded as
    | { kind: "undefined" }
    | { kind: "value"; value: T }
    | {
        kind: "unsupported" | "candidateError" | "inspectorError";
        message: string;
      };
  if (result?.kind === "unsupported")
    failGraderInfrastructure(result.message, "probe_unsupported");
  if (result?.kind === "inspectorError")
    failGraderInfrastructure(
      `Query inspector failed before candidate execution: ${result.message}`,
      "probe_execution",
    );
  if (result?.kind === "candidateError")
    throw new Error(`Query probe failed: ${result.message}`);
  if (result?.kind === "undefined") return undefined as T;
  if (result?.kind === "value") return result.value;
  failGraderInfrastructure("Invalid query probe response", "probe_response");
}
