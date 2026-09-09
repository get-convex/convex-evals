import { build, type Loader } from "esbuild";
import { builtinModules } from "node:module";
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import ts from "typescript";

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
  throw new Error("The generated server module has no env export to inspect");
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
  const convexDir = realpathSync(join(projectDir, "convex"));
  const packageDir = realpathSync(join(projectDir, "node_modules"));
  const inspector = realpathSync(fileURLToPath(inspectorUrl));
  const modules = moduleFiles(convexDir).map((path) => {
    const name = relative(convexDir, path)
      .split(sep)
      .join("/")
      .replace(/\.(ts|js)$/, "");
    return `${JSON.stringify(name)}: () => import(${JSON.stringify(path)})`;
  });
  const defines: Record<string, string> = options.isolateTypedEnv
    ? {}
    : { "process.env": "{}" };
  const bundle = await build({
    stdin: {
      contents: `import { inspect } from ${JSON.stringify(inspector)};
export default inspect({${modules.join(",")}}, ${JSON.stringify(input)});`,
      resolveDir: projectDir,
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
    // External host modules have no loader inside QuickJS. They are never
    // imported or executed by Node, including in otherwise-unused modules.
    external: [...builtinModules, "node:*"],
    plugins: [
      {
        name: "restrict-probe-inputs",
        setup(builder) {
          builder.onLoad({ filter: /.*/ }, (args) => {
            const path = realpathSync(args.path);
            const allowed =
              path === inspector ||
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

  // The worker runs only our trusted interpreter wrapper. Generated code stays
  // inside WebAssembly, with no host functions or module loader exposed.
  return await new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("./querySandboxWorker.mjs", import.meta.url),
      {
        workerData: bundle.outputFiles[0].text,
      },
    );
    const timeout = setTimeout(() => {
      reject(new Error("Query probe timed out"));
      void worker.terminate();
    }, 10_000);
    worker.once("message", (message: { error: string } | { result: T }) => {
      clearTimeout(timeout);
      void worker.terminate();
      if ("error" in message) reject(new Error(message.error));
      else resolve(message.result);
    });
    worker.once("error", (error: Error) => {
      clearTimeout(timeout);
      reject(error);
      void worker.terminate();
    });
    worker.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Query probe exited before reporting (${code})`));
    });
  });
}
