import {
  candidateProbeFailure,
  unsupportedProbe,
} from "../../../grader/probeErrors.mjs";

export async function inspect(
  modules,
  { timeArgName, now },
  { jsonToConvex, convexToJson },
) {
  if (!modules.index)
    candidateProbeFailure("Missing required module convex/index.ts");
  const violations = [];
  const nativeConvex = globalThis.Convex;
  const functionNames = new Map();

  function clockRead(message) {
    violations.push(message);
    throw new Error(message);
  }

  // Install before importing candidate modules so aliases and imported helpers
  // see the same clock restriction. Deterministic date conversion remains valid.
  const NativeDate = Date;
  NativeDate.now = () => clockRead("Query read the wall clock with Date.now()");
  globalThis.Date = new Proxy(NativeDate, {
    apply() {
      clockRead("Query read the wall clock with Date()");
    },
    construct(target, args, newTarget) {
      if (args.length === 0)
        clockRead("Query read the wall clock with new Date()");
      return Reflect.construct(target, args, newTarget);
    },
  });
  NativeDate.prototype.constructor = globalThis.Date;

  function trapMethod(object, name, readsClock = () => true) {
    const descriptor = Object.getOwnPropertyDescriptor(object, name);
    if (!descriptor || typeof descriptor.value !== "function")
      unsupportedProbe(`Clock probe cannot instrument method ${name}`);
    Object.defineProperty(object, name, {
      ...descriptor,
      value: new Proxy(descriptor.value, {
        apply(target, receiver, args) {
          if (readsClock(args))
            clockRead(`Query read the wall clock with ${name}()`);
          return Reflect.apply(target, receiver, args);
        },
      }),
    });
  }

  // Temporal bypasses Date.now. Its Now namespace also has timeZoneId(),
  // which does not read a timestamp and must remain usable.
  if (globalThis.Temporal?.Now) {
    for (const name of [
      "instant",
      "plainDateTimeISO",
      "zonedDateTimeISO",
      "plainDateISO",
      "plainTimeISO",
    ]) {
      if (typeof globalThis.Temporal.Now[name] === "function")
        trapMethod(globalThis.Temporal.Now, name);
    }
  }

  // Intl uses the current instant only when its timestamp is omitted/undefined.
  // Preserve native bound-function identity and allow explicit date formatting.
  const dateTimeFormat = globalThis.Intl?.DateTimeFormat?.prototype;
  if (dateTimeFormat) {
    const descriptor = Object.getOwnPropertyDescriptor(
      dateTimeFormat,
      "format",
    );
    if (typeof descriptor?.get !== "function")
      unsupportedProbe(
        "Clock probe cannot instrument Intl.DateTimeFormat.format",
      );
    const boundFormats = new WeakMap();
    Object.defineProperty(dateTimeFormat, "format", {
      ...descriptor,
      get() {
        const nativeFormat = Reflect.apply(descriptor.get, this, []);
        if (!boundFormats.has(nativeFormat)) {
          boundFormats.set(
            nativeFormat,
            new Proxy(nativeFormat, {
              apply(target, receiver, args) {
                if (args[0] === undefined)
                  clockRead("Query read the wall clock with Intl.format()");
                return Reflect.apply(target, receiver, args);
              },
            }),
          );
        }
        return boundFormats.get(nativeFormat);
      },
    });
    trapMethod(
      dateTimeFormat,
      "formatToParts",
      (args) => args[0] === undefined,
    );
  }

  // performance.now() measures elapsed time. Its epoch-valued timeOrigin and
  // toJSON() expose wall time, including through prototype/descriptor access.
  if (globalThis.performance) {
    for (const name of ["timeOrigin", "toJSON"]) {
      let owner = globalThis.performance;
      while (owner && !Object.hasOwn(owner, name))
        owner = Object.getPrototypeOf(owner);
      if (!owner) continue;
      if (name === "toJSON") {
        trapMethod(owner, name);
      } else {
        const descriptor = Object.getOwnPropertyDescriptor(owner, name);
        if (typeof descriptor.get !== "function")
          unsupportedProbe(
            "Clock probe cannot instrument performance.timeOrigin",
          );
        Object.defineProperty(owner, name, {
          ...descriptor,
          get: new Proxy(descriptor.get, {
            apply() {
              clockRead(
                "Query read the wall clock with performance.timeOrigin",
              );
            },
          }),
        });
      }
    }
  }

  async function invoke(name, args) {
    const [moduleName, exportName = "default"] = name.split(":");
    if (!modules[moduleName])
      unsupportedProbe(`Clock probe cannot load query module ${moduleName}`);
    const module = await modules[moduleName]();
    if (typeof module[exportName]?.invokeQuery !== "function")
      throw new Error(`Missing query ${name}`);
    return jsonToConvex(
      JSON.parse(await module[exportName].invokeQuery(JSON.stringify([args]))),
    );
  }

  globalThis.Convex = {
    ...nativeConvex,
    async asyncSyscall(op, jsonArgs) {
      const args = JSON.parse(jsonArgs);
      if (op === "1.0/createFunctionHandle") {
        if (!args.name)
          unsupportedProbe("Clock probe cannot resolve this function address");
        const result = await nativeConvex.asyncSyscall(op, jsonArgs);
        functionNames.set(JSON.parse(result), args.name);
        return result;
      }
      if (
        op === "1.0/runUdf" &&
        ["query", "snapshotQuery"].includes(args.udfType)
      ) {
        const name = args.name ?? functionNames.get(args.functionHandle);
        if (!name)
          unsupportedProbe("Clock probe cannot resolve this nested query");
        // Keep same-project query helpers in the trapped context. Letting a
        // native nested query run separately would restore its untrapped Date.
        return JSON.stringify(convexToJson(await invoke(name, args.args)));
      }
      // Database semantics belong to Convex. The one-off transaction is never
      // committed; seeded rows exercise empty, partial and full results.
      return await nativeConvex.asyncSyscall(op, jsonArgs);
    },
  };

  const result = await invoke("index:listActive", { [timeArgName]: now });
  if (violations.length) throw new Error(violations.join("; "));
  return { result };
}
