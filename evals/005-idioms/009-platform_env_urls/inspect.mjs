import {
  candidateProbeFailure,
  unsupportedProbe,
} from "../../../grader/probeErrors.mjs";

export async function inspect(
  modules,
  { env },
  { jsonToConvex, convexToJson },
) {
  const nativeConvex = globalThis.Convex;
  const functionNames = new Map();
  const keys = new Set([
    "CONVEX_SITE_URL",
    "CONVEX_CLOUD_URL",
    "PUBLIC_APP_NAME",
  ]);
  const reads = new Set();
  const violations = [];
  function record(key, typed) {
    if (typed) {
      if (keys.has(key)) reads.add(key);
    } else if (typeof key === "string") {
      // This task forbids every raw variable, unlike the app-env task's
      // narrower restriction to its two named application variables.
      const message = `Read environment variable ${key} through process.env`;
      violations.push(message);
      throw new Error(message);
    }
  }
  function trackedEnv(typed) {
    return new Proxy(
      {},
      {
        get(target, key) {
          record(key, typed);
          return Object.prototype.hasOwnProperty.call(env, key)
            ? env[key]
            : undefined;
        },
      },
    );
  }
  // Convex exposes env values by property reads, not enumerable own properties.
  // Install before imports so module-level and imported helper reads count too.
  globalThis.process = { env: trackedEnv(false) };
  globalThis.__convexTypedEnv = trackedEnv(true);
  async function invoke(name, args, required = false) {
    const [moduleName, exportName = "default"] = name.split(":");
    if (!modules[moduleName]) {
      if (required)
        candidateProbeFailure(
          `Missing required module convex/${moduleName}.ts`,
        );
      unsupportedProbe(
        `The platform-env probe cannot load query module ${moduleName}`,
      );
    }
    const module = await modules[moduleName]();
    if (typeof module[exportName]?.invokeQuery !== "function")
      candidateProbeFailure(`Missing query ${name}`);
    return jsonToConvex(
      JSON.parse(await module[exportName].invokeQuery(JSON.stringify([args]))),
    );
  }
  globalThis.Convex = {
    ...nativeConvex,
    async asyncSyscall(op, jsonArgs) {
      const args = JSON.parse(jsonArgs);
      if (op === "1.0/createFunctionHandle") {
        const name = args.name ?? functionNames.get(args.functionHandle);
        if (!name)
          unsupportedProbe(
            "The platform-env probe cannot resolve this function address",
          );
        // Convex owns handle serialization; remember the explicitly named target.
        const result = await nativeConvex.asyncSyscall(op, jsonArgs);
        functionNames.set(JSON.parse(result), name);
        return result;
      }
      if (
        op === "1.0/runUdf" &&
        ["query", "snapshotQuery"].includes(args.udfType)
      ) {
        const name = args.name ?? functionNames.get(args.functionHandle);
        if (!name)
          unsupportedProbe(
            "The platform-env probe cannot resolve this nested query",
          );
        // Native nested execution would escape the synthetic typed/raw env
        // objects. Invoke bundled helpers in this same instrumented context.
        return JSON.stringify(convexToJson(await invoke(name, args.args)));
      }
      // Auth, database and other ordinary operations retain Convex semantics.
      // The enclosing native query prevents nested mutations and external I/O.
      return await nativeConvex.asyncSyscall(op, jsonArgs);
    },
  };
  const result = await invoke("deployment:getDeploymentInfo", {}, true);
  if (violations.length) throw new Error(violations.join("; "));
  return { result, reads: [...reads].sort() };
}
