import { build, type Loader } from "esbuild";
import { builtinModules } from "node:module";
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

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
    // Newer generated Convex server modules export process.env. Supply an empty
    // guest environment without exposing the host's process or credentials.
    define: { "process.env": "{}" },
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
            return {
              contents: readFileSync(path, "utf8"),
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
