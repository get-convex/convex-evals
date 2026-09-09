export async function inspect(modules, { env }) {
  const appKeys = new Set(["SUPPORT_EMAIL", "DEPLOYMENT_STAGE"]);
  const reads = new Set();
  const violations = [];
  function record(key, typed) {
    if (!appKeys.has(key)) return;
    if (typed) reads.add(key);
    else {
      const message = `Read app variable ${key} through process.env`;
      violations.push(message);
      throw new Error(message);
    }
  }
  function trackedEnv(typed) {
    // Convex exposes env values through property reads, not enumerable own
    // properties. Match that distinction so spread and `in` behave as they do
    // on the backend instead of accidentally making a broken answer work here.
    return new Proxy(
      {},
      {
        get(target, key) {
          record(key, typed);
          return Object.prototype.hasOwnProperty.call(env, key)
            ? env[key]
            : undefined;
        },
        has(target, key) {
          record(key, typed);
          return Reflect.has(target, key);
        },
        getOwnPropertyDescriptor(target, key) {
          record(key, typed);
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      },
    );
  }
  // Install before importing model modules, including module-level reads and
  // helper imports. The generated server export alone receives the typed object.
  // These guest objects contain only synthetic test values, never host env vars.
  globalThis.process = { env: trackedEnv(false) };
  globalThis.__convexTypedEnv = trackedEnv(true);

  async function invoke(name, args) {
    const [moduleName, exportName = "default"] = name.split(":");
    const module = await modules[moduleName]();
    if (typeof module[exportName]?.invokeQuery !== "function")
      throw new Error(`Missing query ${name}`);
    return JSON.parse(
      await module[exportName].invokeQuery(JSON.stringify([args])),
    );
  }
  globalThis.Convex = {
    async asyncSyscall(op, jsonArgs) {
      const args = JSON.parse(jsonArgs);
      if (op === "1.0/runUdf" && args.udfType === "query")
        return JSON.stringify(await invoke(args.name, args.args));
      throw new Error(`Unsupported typed-env probe syscall: ${op}`);
    },
  };

  const result = await invoke("config:getSupportConfig", {});
  // Catch-and-fallback code must not hide a prohibited process.env read.
  if (violations.length) throw new Error(violations.join("; "));
  return { result, reads: [...reads].sort() };
}
